package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kartoza/decision-theatre/internal/httputil"
)

// Place-name search, proxied.
//
// The browser used to call nominatim.openstreetmap.org directly. The OSM
// Nominatim usage policy requires an identifying User-Agent naming the
// application with a way to contact whoever runs it, asks that results be cached,
// and caps traffic at one request per second.
//
// None of that is achievable from browser JavaScript: User-Agent is a forbidden
// header name in the Fetch specification, so `fetch` silently cannot set it, and
// a per-tab debounce is not a rate limit — ten open tabs are ten times the
// traffic. The only place able to honour the policy is the server, which speaks
// once for the whole deployment.
//
// So this endpoint exists. It is not a feature; it is the difference between
// using somebody's free service within their terms and outside them.

const (
	// nominatimSearchURL is the upstream endpoint.
	nominatimSearchURL = "https://nominatim.openstreetmap.org/search"

	// nominatimContact identifies this application to the upstream operator. A
	// repository URL is accepted practice and, unlike a personal address, does
	// not go stale when people change jobs.
	nominatimContact = "https://github.com/kartoza/DecisionTheatre"

	// nominatimMinInterval is the published limit: one request per second,
	// absolute, across the whole deployment.
	nominatimMinInterval = time.Second

	// geocodeCacheTTL is how long an answer is reused. Place names do not move,
	// so this is bounded by wanting new places to appear eventually rather than
	// by staleness. Caching is itself part of the usage policy.
	geocodeCacheTTL = 15 * time.Minute

	// geocodeCacheMax bounds the cache so that a stream of distinct queries
	// cannot grow it without limit.
	geocodeCacheMax = 500

	// geocodeMaxQueryLen is generous for a place name and stops a caller using
	// this endpoint to push arbitrary volume upstream under our name.
	geocodeMaxQueryLen = 200

	// geocodeMaxResults matches what the client asks for.
	geocodeMaxResults = 8

	// geocodeUpstreamTimeout bounds a slow upstream. The client treats a failure
	// as "no online results" and keeps its local matches, so failing fast is
	// better than holding the request.
	geocodeUpstreamTimeout = 8 * time.Second
)

// place is the normalised result shape.
//
// Deliberately not Nominatim's schema: the client should not know which geocoder
// answered, so swapping to a self-hosted or commercial one later is a change to
// this file alone.
type place struct {
	Name string  `json:"name"`
	Lng  float64 `json:"lng"`
	Lat  float64 `json:"lat"`
}

type geocodeCacheEntry struct {
	places []place
	at     time.Time
}

// geocodeLimiter serialises upstream calls and keeps them a second apart.
type geocodeLimiter struct {
	mu     sync.Mutex
	last   time.Time
	cache  map[string]geocodeCacheEntry
	client *http.Client

	// userAgent is what the upstream operator sees. Built once from the running
	// version so a report about our traffic can name a release.
	userAgent string

	// searchURL is the upstream endpoint, a field only so a test can point it at
	// a local server instead of sending real traffic to OSM.
	searchURL string
}

func newGeocodeLimiter(version string) *geocodeLimiter {
	if version == "" {
		version = "dev"
	}
	return &geocodeLimiter{
		cache:     make(map[string]geocodeCacheEntry),
		client:    &http.Client{Timeout: geocodeUpstreamTimeout},
		userAgent: fmt.Sprintf("DecisionTheatre/%s (+%s)", version, nominatimContact),
		searchURL: nominatimSearchURL,
	}
}

// cached returns a cached answer for a query, if it is still fresh.
func (g *geocodeLimiter) cached(query string) ([]place, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()

	entry, ok := g.cache[query]
	if !ok || time.Since(entry.at) > geocodeCacheTTL {
		return nil, false
	}
	return entry.places, true
}

func (g *geocodeLimiter) store(query string, places []place) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if len(g.cache) >= geocodeCacheMax {
		// Drop the whole cache rather than tracking an eviction order: entries
		// are cheap to refetch and this happens rarely.
		g.cache = make(map[string]geocodeCacheEntry, geocodeCacheMax)
	}
	g.cache[query] = geocodeCacheEntry{places: places, at: time.Now()}
}

// reserve claims the next upstream slot, returning how long the caller must wait
// before using it. Callers that would wait too long are refused instead.
func (g *geocodeLimiter) reserve() time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()

	wait := time.Until(g.last.Add(nominatimMinInterval))
	if wait < 0 {
		wait = 0
	}
	// Claim the slot now, so concurrent callers queue behind each other rather
	// than all seeing the same free slot.
	g.last = time.Now().Add(wait)
	return wait
}

// handleGeocode searches for a place by name.
func (s *Server) handleGeocode(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		httputil.RespondError(w, http.StatusBadRequest, "q parameter is required")
		return
	}
	if len(query) > geocodeMaxQueryLen {
		httputil.RespondError(w, http.StatusBadRequest, "q parameter is too long")
		return
	}

	key := strings.ToLower(query)
	if places, ok := s.geocode.cached(key); ok {
		httputil.RespondJSON(w, http.StatusOK, places)
		return
	}

	// Waiting out the rate limit is right for a single queued request and wrong
	// for a queue of them: the client has already given up by then, and the
	// goroutine would be held for nothing.
	wait := s.geocode.reserve()
	if wait > 3*time.Second {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		httputil.RespondError(w, http.StatusTooManyRequests,
			"place search is rate limited; try again shortly")
		return
	}
	if wait > 0 {
		select {
		case <-time.After(wait):
		case <-r.Context().Done():
			// The client navigated away or the debounce superseded this.
			return
		}
	}

	places, err := s.geocode.search(r.Context(), query)
	if err != nil {
		// Not an error worth surfacing loudly: the client falls back to its
		// bundled gazetteer, so search still works.
		httputil.RespondJSON(w, http.StatusOK, []place{})
		return
	}

	s.geocode.store(key, places)
	httputil.RespondJSON(w, http.StatusOK, places)
}

// search performs one upstream request, identifying this application.
func (g *geocodeLimiter) search(ctx context.Context, query string) ([]place, error) {
	params := url.Values{}
	params.Set("format", "jsonv2")
	params.Set("q", query)
	params.Set("limit", strconv.Itoa(geocodeMaxResults))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		g.searchURL+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}

	// The header the browser could not send. Without it the policy is not being
	// met, whatever else this code does.
	req.Header.Set("User-Agent", g.userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("geocoder returned %d", resp.StatusCode)
	}

	// Bounded so a misbehaving upstream cannot make this process buffer without
	// limit; a search for eight places is a few kilobytes.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	var results []struct {
		Lat         string `json:"lat"`
		Lon         string `json:"lon"`
		DisplayName string `json:"display_name"`
	}
	if err := json.Unmarshal(body, &results); err != nil {
		return nil, err
	}

	places := make([]place, 0, len(results))
	for _, result := range results {
		lng, lngErr := strconv.ParseFloat(result.Lon, 64)
		lat, latErr := strconv.ParseFloat(result.Lat, 64)
		if lngErr != nil || latErr != nil {
			continue
		}
		places = append(places, place{Name: result.DisplayName, Lng: lng, Lat: lat})
	}
	return places, nil
}
