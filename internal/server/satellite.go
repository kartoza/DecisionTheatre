package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
)

// Satellite imagery, proxied.
//
// The browser used to fetch tiles directly from the configured provider. That
// worked, but it meant the one thing standing between this deployment and a
// provider's free-tier terms — a monthly tile count, see
// config.DefaultSatelliteQuotaLimit — was invisible to the one process able to
// enforce it, and (for a keyed provider like MapTiler) the key itself would
// have to live in browser JavaScript.
//
// The upstream is now a whole style — MapTiler's Hybrid, satellite imagery
// with OSM-derived roads and place labels already composited in — rather than
// one raster tile template, so this file resolves and rewrites it: every
// source's tiles, its sprite and its glyphs all end up pointing back at this
// server, which is the only thing that ever holds the key.

const (
	// satelliteTileCacheLimit caps the in-process tile cache, mirroring the
	// glyph cache's reasoning: panning back over the same area should not count
	// against the monthly quota twice.
	satelliteTileCacheLimit = 256 * 1024 * 1024

	// satelliteUpstreamTimeout bounds a slow provider. MapLibre already renders
	// gracefully with a missing raster tile, so failing fast beats holding the
	// connection open.
	satelliteUpstreamTimeout = 10 * time.Second

	// satelliteMaxTileBytes bounds a single tile or sprite image response so a
	// misbehaving upstream cannot make this process buffer without limit.
	satelliteMaxTileBytes = 4 << 20

	// satelliteMaxStyleBytes bounds the style and TileJSON documents, which are
	// plain metadata and always small.
	satelliteMaxStyleBytes = 1 << 20
)

type satelliteTile struct {
	data            []byte
	contentType     string
	contentEncoding string
}

// satelliteTileProxy fetches, caches and quota-counts everything the Hybrid
// style needs: the style document itself, each source's tiles (raster and
// vector alike), and its sprite. Glyphs are deliberately excluded — see
// buildStyle — and reuse the existing font proxy instead.
type satelliteTileProxy struct {
	cache      sync.Map // "source/z/x/y" -> satelliteTile
	cacheSizeB atomic.Int64

	client     *http.Client
	styleURL   string
	usage      *config.SatelliteUsage
	quotaLimit int

	// The rewritten /api/satellite-style.json, built once and cached for the
	// process lifetime — MapTiler serves the same content to everyone, so
	// there is nothing here that ever needs invalidating.
	style styleCache

	// Populated as the style, and each source's TileJSON, are resolved — see
	// buildStyle and handleSatelliteTileJSON. A tile request for a source not
	// yet resolved this way 404s; in practice MapLibre always fetches a
	// source's style entry (and its TileJSON, if it has one) before ever
	// requesting a tile from it.
	tileUpstream     sync.Map // source id -> upstream {z}/{x}/{y} template
	tileJSONUpstream sync.Map // source id -> upstream TileJSON URL
	tileJSONCache    sync.Map // source id -> rewritten TileJSON bytes

	// The sprite is one URL for the whole style, not per-source, hence a
	// single pointer rather than a map. nil until buildStyle resolves it —
	// which may never happen, since not every style has a sprite.
	spriteUpstream atomic.Pointer[string]
	spriteCache    sync.Map // variant (".png", "@2x.json", ...) -> satelliteTile
}

func newSatelliteTileProxy(cfg config.Config, usage *config.SatelliteUsage) *satelliteTileProxy {
	styleURL, _ := cfg.Satellite()
	return &satelliteTileProxy{
		client: &http.Client{
			Timeout: satelliteUpstreamTimeout,
			// Vector tiles arrive gzip-compressed; the default Transport
			// transparently decompresses a gzip response and strips
			// Content-Encoding before this code ever sees it, which broke
			// forwarding that header to the browser (and would have made this
			// process do the decompress work for nothing, on every tile).
			// Disabling it keeps bytes and headers exactly as upstream sent
			// them — the browser decompresses, same as it would talking to
			// MapTiler directly.
			Transport: &http.Transport{DisableCompression: true},
		},
		styleURL:   styleURL,
		usage:      usage,
		quotaLimit: cfg.SatelliteQuota(),
	}
}

// fetchUpstream performs one bounded GET. Shared by every route in this file
// that talks to the provider directly (style, TileJSON, sprite) — only the
// quota-checked, cached tile path (serve, below) needs its own version, since
// it alone counts and caps what it fetches.
func fetchUpstream(ctx context.Context, client *http.Client, url string, maxBytes int64) ([]byte, http.Header, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("upstream returned %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes))
	if err != nil {
		return nil, nil, err
	}
	return data, resp.Header, nil
}

// buildStyle fetches the upstream style once, resolving and rewriting every
// source so the browser only ever talks to this server: a source with inline
// tiles becomes a local /api/satellite-tile path, one with a TileJSON
// reference becomes /api/satellite-tilejson, and the sprite becomes
// /api/satellite-sprite. Every rewritten URL is absolute, not relative — a
// relative one resolves against whatever fetched it, and MapLibre fetches
// vector tiles from inside a Web Worker, whose location is its own script
// (often a blob: URL), not the page. A relative vector tile URL therefore
// fails there with "Failed to construct 'Request': Failed to parse URL",
// silently dropping the whole source — raster tiles, the style and the
// sprite are all fetched on the main thread and tolerate a relative URL fine,
// which is exactly why this went unnoticed until roads (vector) were added.
// Matches handleStyleJSON's existing baseURL(r)-based rewriting of the app's
// own vector basemap, for the same reason.
//
// glyphs is the one exception: rewritten to the existing local font proxy
// (handleGlyphProxy) rather than a new one of its own, and that traffic is
// deliberately not folded into the satellite quota below — see the package
// doc comment.
func (p *satelliteTileProxy) buildStyle(base string) ([]byte, error) {
	data, _, err := fetchUpstream(context.Background(), p.client, p.styleURL, satelliteMaxStyleBytes)
	if err != nil {
		return nil, err
	}

	var style map[string]interface{}
	if err := json.Unmarshal(data, &style); err != nil {
		return nil, err
	}

	if sources, ok := style["sources"].(map[string]interface{}); ok {
		for id, raw := range sources {
			src, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}

			if tiles, ok := src["tiles"].([]interface{}); ok && len(tiles) > 0 {
				if tmpl, ok := tiles[0].(string); ok {
					p.tileUpstream.Store(id, tmpl)
				}
				src["tiles"] = []string{base + "/api/satellite-tile/" + id + "/{z}/{x}/{y}"}
				delete(src, "url")
			} else if tilejsonURL, ok := src["url"].(string); ok && tilejsonURL != "" {
				p.tileJSONUpstream.Store(id, tilejsonURL)
				src["url"] = base + "/api/satellite-tilejson/" + id
			}

			sources[id] = src
		}
	}

	if spriteURL, ok := style["sprite"].(string); ok && spriteURL != "" {
		p.spriteUpstream.Store(&spriteURL)
		style["sprite"] = base + "/api/satellite-sprite"
	}

	if glyphsURL, ok := style["glyphs"].(string); ok && glyphsURL != "" {
		style["glyphs"] = base + "/fonts/{fontstack}/{range}.pbf"
	}

	return json.Marshal(style)
}

// handleSatelliteStyle serves the rewritten Hybrid style document.
func (s *Server) handleSatelliteStyle(w http.ResponseWriter, r *http.Request) {
	base := baseURL(r)
	styleBytes, err := s.satellite.style.get(func() ([]byte, error) {
		return s.satellite.buildStyle(base)
	})
	if err != nil {
		log.Printf("Satellite style proxy: upstream fetch failed: %v", err)
		http.Error(w, "Satellite style unavailable", http.StatusBadGateway)
		return
	}

	writeSatelliteJSON(w, styleBytes)
}

// handleSatelliteTileJSON resolves one source's TileJSON — the indirection
// MapTiler's style sources use instead of an inline tile template. Rewriting
// it is what lets handleSatelliteTile resolve that source's real upstream
// template; mirrors handleTileJSON's job for the app's own vector basemap.
//
// The rewritten result is cached: MapLibre re-fetches a source's TileJSON for
// every map instance that uses it (all twelve panes in grid view, for
// example), and none of that is a "tile" the quota should count.
func (s *Server) handleSatelliteTileJSON(w http.ResponseWriter, r *http.Request) {
	source := mux.Vars(r)["source"]
	p := s.satellite

	if cached, ok := p.tileJSONCache.Load(source); ok {
		writeSatelliteJSON(w, cached.([]byte))
		return
	}

	upstreamRaw, ok := p.tileJSONUpstream.Load(source)
	if !ok {
		http.Error(w, "Unknown satellite source", http.StatusNotFound)
		return
	}

	data, _, err := fetchUpstream(r.Context(), p.client, upstreamRaw.(string), satelliteMaxStyleBytes)
	if err != nil {
		log.Printf("Satellite tilejson proxy: upstream fetch failed for %s: %v", source, err)
		http.Error(w, "Satellite tilejson unavailable", http.StatusBadGateway)
		return
	}

	var tileJSON map[string]interface{}
	if err := json.Unmarshal(data, &tileJSON); err != nil {
		http.Error(w, "Satellite tilejson unavailable", http.StatusBadGateway)
		return
	}
	if tiles, ok := tileJSON["tiles"].([]interface{}); ok && len(tiles) > 0 {
		if tmpl, ok := tiles[0].(string); ok {
			p.tileUpstream.Store(source, tmpl)
		}
	}
	// Absolute, not relative — see buildStyle's doc comment: MapLibre fetches
	// vector tiles from a Worker, where a relative URL cannot be resolved.
	tileJSON["tiles"] = []string{baseURL(r) + "/api/satellite-tile/" + source + "/{z}/{x}/{y}"}

	out, err := json.Marshal(tileJSON)
	if err != nil {
		http.Error(w, "Satellite tilejson unavailable", http.StatusInternalServerError)
		return
	}
	p.tileJSONCache.Store(source, out)
	writeSatelliteJSON(w, out)
}

// writeSatelliteJSON writes a JSON response (the style or a TileJSON
// document) with the headers every such response needs: cacheable, and
// CORS-open. The style and TileJSON documents now embed absolute URLs (see
// buildStyle), so a dev setup that serves the frontend and this backend from
// different origins — Vite on :5173 proxying everything else to :8080 — has
// the browser fetch those URLs directly rather than through the proxy. Same
// header the local vector tile route (handleTileRequest) already sets, for
// the same reason.
func writeSatelliteJSON(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(body)
}

// handleSatelliteTile serves one z/x/y tile from the named source, fetching
// and caching it from the upstream provider on first request.
func (s *Server) handleSatelliteTile(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	source := vars["source"]
	// Rejected rather than defaulted: see handleTileRequest for why a malformed
	// coordinate must not silently become tile 0/0/0.
	z, zErr := strconv.Atoi(vars["z"])
	x, xErr := strconv.Atoi(vars["x"])
	y, yErr := strconv.Atoi(vars["y"])
	if zErr != nil || xErr != nil || yErr != nil {
		http.Error(w, "Invalid tile coordinate", http.StatusBadRequest)
		return
	}

	s.satellite.serve(r.Context(), w, source, z, x, y)
}

func (p *satelliteTileProxy) serve(ctx context.Context, w http.ResponseWriter, source string, z, x, y int) {
	upstreamRaw, ok := p.tileUpstream.Load(source)
	if !ok {
		// The style or TileJSON that names this source has not been resolved
		// yet — or never will be, if the id is bogus. Either way there is no
		// upstream to fetch from.
		http.Error(w, "Unknown satellite source", http.StatusNotFound)
		return
	}
	template := upstreamRaw.(string)

	key := source + "/" + strconv.Itoa(z) + "/" + strconv.Itoa(x) + "/" + strconv.Itoa(y)

	if v, ok := p.cache.Load(key); ok {
		writeSatelliteTile(w, v.(satelliteTile))
		return
	}

	// Checked before fetching, not only after: once the quota is spent, a cache
	// miss must not reach the upstream at all, or the count keeps climbing past
	// the limit it exists to enforce. This is a soft cap, not an exact one — a
	// handful of requests already in flight when the limit is crossed can still
	// land — which is the right trade for a monthly quota, not worth serialising
	// every tile fetch over.
	if _, exceeded := p.usage.Snapshot(p.quotaLimit); exceeded {
		w.Header().Set("Retry-After", "86400")
		http.Error(w, "Satellite imagery quota exceeded for this month", http.StatusTooManyRequests)
		return
	}

	tile, err := p.fetch(ctx, template, z, x, y)
	if err != nil {
		log.Printf("Satellite tile proxy: upstream fetch failed for %s: %v", key, err)
		http.Error(w, "Satellite tile unavailable", http.StatusBadGateway)
		return
	}

	p.usage.Increment(p.quotaLimit)

	if p.cacheSizeB.Load() < satelliteTileCacheLimit {
		if _, loaded := p.cache.LoadOrStore(key, tile); !loaded {
			p.cacheSizeB.Add(int64(len(tile.data)))
		}
	}

	writeSatelliteTile(w, tile)
}

// fetch performs one upstream request for a single tile from the given
// source's template.
func (p *satelliteTileProxy) fetch(ctx context.Context, template string, z, x, y int) (satelliteTile, error) {
	tileURL := strings.NewReplacer(
		"{z}", strconv.Itoa(z),
		"{x}", strconv.Itoa(x),
		"{y}", strconv.Itoa(y),
	).Replace(template)

	data, header, err := fetchUpstream(ctx, p.client, tileURL, satelliteMaxTileBytes)
	if err != nil {
		return satelliteTile{}, err
	}
	return satelliteTile{
		data:            data,
		contentType:     header.Get("Content-Type"),
		contentEncoding: header.Get("Content-Encoding"),
	}, nil
}

func writeSatelliteTile(w http.ResponseWriter, tile satelliteTile) {
	contentType := tile.contentType
	if contentType == "" {
		// World Imagery and most other providers serve JPEG; a sensible default
		// for the rare response that arrives without a Content-Type header.
		contentType = "image/jpeg"
	}
	w.Header().Set("Content-Type", contentType)
	if tile.contentEncoding != "" {
		// Vector tiles are typically gzip-compressed; raster tiles typically
		// aren't. Forwarded rather than assumed, unlike the local vector tile
		// route (handleTileRequest), which always serves gzip because it always
		// reads from one gzip-compressed local file format.
		w.Header().Set("Content-Encoding", tile.contentEncoding)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	// See writeSatelliteJSON's comment: tile URLs are absolute, so a dev setup
	// with the frontend and backend on different origins needs this.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(tile.data)
}

// handleSatelliteSprite serves the style's sprite sheet — the small set of
// icon images MapLibre needs for symbol layers such as place labels. Cached
// like a tile, but not counted against the quota: a style loads its sprite
// once per session, not once per pan or zoom, so the volume is negligible —
// the same treatment already given to glyphs.
func (s *Server) handleSatelliteSprite(w http.ResponseWriter, r *http.Request) {
	variant := mux.Vars(r)["variant"]
	p := s.satellite

	if v, ok := p.spriteCache.Load(variant); ok {
		writeSatelliteTile(w, v.(satelliteTile))
		return
	}

	base := p.spriteUpstream.Load()
	if base == nil || *base == "" {
		http.Error(w, "No sprite configured", http.StatusNotFound)
		return
	}

	// The variant suffix (".json", "@2x.png", ...) must land on the path, not
	// after the upstream's own "?key=..." query string, or naive concatenation
	// produces "?key=secret.json" instead of "sprite.json?key=secret".
	spriteURL, err := url.Parse(*base)
	if err != nil {
		http.Error(w, "Satellite sprite unavailable", http.StatusBadGateway)
		return
	}
	spriteURL.Path += variant

	data, header, err := fetchUpstream(r.Context(), p.client, spriteURL.String(), satelliteMaxTileBytes)
	if err != nil {
		log.Printf("Satellite sprite proxy: upstream fetch failed for %s: %v", variant, err)
		http.Error(w, "Satellite sprite unavailable", http.StatusBadGateway)
		return
	}

	tile := satelliteTile{data: data, contentType: header.Get("Content-Type")}
	p.spriteCache.Store(variant, tile)
	writeSatelliteTile(w, tile)
}
