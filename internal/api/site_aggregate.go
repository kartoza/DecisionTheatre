package api

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/sites"
)

// siteFromRequest resolves the site a per-site data endpoint is being asked
// about, for either runtime.
//
// The desktop build keeps sites on disk and asks for them by id; the browser
// build keeps them in the user's own storage and posts them in the request
// body, because a user's sites are not ours to hold. Three endpoints
// (/catchments, /whiskers, /summary) accept both and had a verbatim copy of
// this each.
//
// It writes the response itself and reports ok=false when the request cannot
// be served, so callers can simply return.
func (h *Handler) siteFromRequest(w http.ResponseWriter, r *http.Request) (*sites.Site, bool) {
	id := mux.Vars(r)["id"]

	if r.Method == http.MethodPost {
		var req ExtractIndicatorsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return nil, false
		}

		if req.Runtime == "browser" {
			if len(req.Site) == 0 {
				respondError(w, http.StatusBadRequest, "browser runtime requires site data in request body")
				return nil, false
			}
			siteJSON, err := json.Marshal(req.Site)
			if err != nil {
				respondError(w, http.StatusBadRequest, "invalid site data in request body")
				return nil, false
			}
			site := &sites.Site{}
			if err := json.Unmarshal(siteJSON, site); err != nil {
				respondError(w, http.StatusBadRequest, "invalid site data in request body")
				return nil, false
			}
			return h.checkSiteHasCatchments(w, site)
		}
	}

	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return nil, false
	}
	site, err := h.siteStore.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return nil, false
	}
	return h.checkSiteHasCatchments(w, site)
}

func (h *Handler) checkSiteHasCatchments(w http.ResponseWriter, site *sites.Site) (*sites.Site, bool) {
	if len(site.CatchmentIDs) == 0 && len(site.Catchments) == 0 {
		respondError(w, http.StatusBadRequest, "site has no associated catchments")
		return nil, false
	}
	return site, true
}

// hasCachedCatchments reports whether the site already carries the
// per-catchment records it was asked about, so no database read is needed.
func hasCachedCatchments(site *sites.Site) bool {
	return len(site.Catchments) > 0 &&
		(len(site.CatchmentIDs) == 0 || len(site.Catchments) == len(site.CatchmentIDs))
}

// siteCatchmentWeights returns each of a site's catchments reduced to what a
// weighted aggregate needs - id, area and AOI fraction - and nothing else.
//
// This is the cheap shape: no indicator values are read, so it is not subject
// to the per-catchment response bound and works for a site of any size. Both
// the whisker bounds and the indicator summary are weighted means, so this is
// all either of them ever needed.
func (h *Handler) siteCatchmentWeights(r *http.Request, site *sites.Site) ([]geodata.CatchmentIndicators, error) {
	if hasCachedCatchments(site) {
		return siteCatchmentsToIndicators(site.Catchments), nil
	}

	catchments, err := h.gpkgStore.GetCatchmentAreasByIDs(r.Context(), site.CatchmentIDs)
	if err != nil {
		return nil, err
	}

	// Catchment-created sites are dissolved from the catchments themselves, so
	// every one of them is wholly inside the boundary and the expensive
	// intersection is skipped.
	if len(site.Geometry) > 0 && site.CreationMethod != "catchments" {
		if err := h.gpkgStore.ApplyAOIFractions(r.Context(), catchments, site.Geometry); err != nil {
			return nil, err
		}
	}
	return catchments, nil
}

// slimCatchment is the id/area/fraction view of a catchment: what the map view
// needs for AOI filtering, without the indicator values it never reads.
type slimCatchment struct {
	ID          string  `json:"id"`
	AreaKm2     float64 `json:"areaKm2"`
	AOIFraction float64 `json:"aoiFraction,omitempty"`
}

func toSlimCatchments(catchments []geodata.CatchmentIndicators) []slimCatchment {
	result := make([]slimCatchment, len(catchments))
	for i, c := range catchments {
		result[i] = slimCatchment{ID: c.ID, AreaKm2: c.AreaKm2, AOIFraction: c.AOIFraction}
	}
	return result
}

// handleSiteSummary returns one number per indicator per scenario for a site:
// the area-weighted mean across its catchments, computed in SQL.
//
// This is the endpoint the table, chart and dial views actually want. Each of
// them reduces a site's catchments to a scalar, so shipping one record per
// catchment to divide them down in the browser was always work done at the
// wrong end - and for a whole-of-Africa site there is no version of that which
// fits in a response at all: the per-catchment payload for 147,837 catchments
// runs to several gigabytes, while this answers the same question in a fixed
// few kilobytes no matter how large the site is.
//
// Catchments themselves are drawn from vector tiles and styled by the
// choropleth, so nothing on screen ever needed to enumerate them.
func (h *Handler) handleSiteSummary(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] handleSiteSummary method=%s duration_ms=%d", r.Method, time.Since(start).Milliseconds())
	}()

	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	site, ok := h.siteFromRequest(w, r)
	if !ok {
		return
	}

	weights, err := h.siteCatchmentWeights(r, site)
	if err != nil {
		respondStoreError(w, r, http.StatusInternalServerError, err)
		return
	}

	summary, err := h.gpkgStore.AggregateCatchmentIndicators(r.Context(), weights)
	if err != nil {
		respondStoreError(w, r, http.StatusInternalServerError, err)
		return
	}

	respondJSON(w, http.StatusOK, summary)
}
