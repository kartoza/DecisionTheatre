package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/sites"
)

// Resetting targets to an observed scenario.
//
// The reset deliberately does not cascade. `current` was produced by
// extraction, not by the cascade formulas, so recomputing derived values from
// the primary inputs lands *near* current rather than on it — and the target
// marker on the dial then visibly misses the current one, which is the bug
// this endpoint's behaviour exists to avoid.
//
// The route is desktop-only on purpose: in browser runtime the client does the
// same work locally, because the user's sites are not sent to the server. These
// tests therefore drive the stored-site path, and the local path is covered on
// the frontend side.

// A desktop-mode handler with a real store holding one site, since that is the
// only runtime this route is registered in.
func resetTestHandler(t *testing.T) (*Handler, *sites.Store) {
	t.Helper()
	dir := t.TempDir()
	store, err := sites.NewStore(dir)
	if err != nil {
		t.Fatalf("site store: %v", err)
	}
	cfg := config.Config{Port: 8080, DataDir: dir, Version: "test", DesktopMode: true}
	return NewHandler(nil, nil, store, cfg, nil), store
}

func storedSite() *sites.Site {
	return &sites.Site{
		ID:    "site-1",
		Title: "Test",
		Indicators: &sites.SiteIndicators{
			// A derived key (`npp`) present in reference and current but with
			// values that no cascade would reproduce, and a primary input
			// (`meanTC`) that a cascade would rewrite.
			Reference: map[string]float64{"npp": 900, "meanTC": 0.6, "refOnly": 42},
			Current:   map[string]float64{"npp": 259, "meanTC": 0.3},
			Ideal:     map[string]float64{"npp": 111, "meanTC": 0.9},
		},
		Catchments: []sites.SiteCatchment{{
			ID:        "c1",
			Reference: map[string]float64{"npp": 800, "meanTC": 0.5},
			Current:   map[string]float64{"npp": 200, "meanTC": 0.2},
			Ideal:     map[string]float64{"npp": 1, "meanTC": 1},
		}},
	}
}

func postReset(t *testing.T, stored *sites.Site, body map[string]any) *sites.Site {
	t.Helper()
	handler, store := resetTestHandler(t)
	created, err := store.Create(stored)
	if err != nil {
		t.Fatalf("seed site: %v", err)
	}
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	_ = created
	req := httptest.NewRequest(http.MethodPost, "/sites/"+created.ID+"/indicators/reset", bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var out sites.Site
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return &out
}

func TestResetToCurrentLandsExactlyOnCurrent(t *testing.T) {
	out := postReset(t, storedSite(), map[string]any{"scenario": "current"})

	// The whole point: equal, not merely close. A cascaded reset would have
	// recomputed npp from meanTC and produced something else.
	if got := out.Indicators.Ideal["npp"]; got != 259 {
		t.Errorf("ideal npp = %v, want 259 (exactly current)", got)
	}
	if got := out.Indicators.Ideal["meanTC"]; got != 0.3 {
		t.Errorf("ideal meanTC = %v, want 0.3 (exactly current)", got)
	}
}

func TestResetToReferenceLandsExactlyOnReference(t *testing.T) {
	out := postReset(t, storedSite(), map[string]any{"scenario": "reference"})

	if got := out.Indicators.Ideal["npp"]; got != 900 {
		t.Errorf("ideal npp = %v, want 900 (exactly reference)", got)
	}
	if got := out.Indicators.Ideal["meanTC"]; got != 0.6 {
		t.Errorf("ideal meanTC = %v, want 0.6 (exactly reference)", got)
	}
}

func TestResetCoversKeysThatAreNotEditableTargets(t *testing.T) {
	// The client-side version of this reset only walked the editable target
	// keys, so a derived factor kept its old ideal and its dial marker stayed
	// where it was. Every key in the scenario has to move.
	out := postReset(t, storedSite(), map[string]any{"scenario": "current"})
	if got := out.Indicators.Ideal["npp"]; got == 111 {
		t.Error("derived key kept its previous ideal; the reset skipped it")
	}
}

func TestResetFallsBackToReferenceForKeysCurrentDoesNotHave(t *testing.T) {
	// Otherwise the key would drop out of the ideal map entirely and the dial
	// would lose its target rather than moving it.
	out := postReset(t, storedSite(), map[string]any{"scenario": "current"})
	if got := out.Indicators.Ideal["refOnly"]; got != 42 {
		t.Errorf("refOnly = %v, want 42 from reference", got)
	}
}

func TestResetMovesCatchmentIdealsToo(t *testing.T) {
	// Left behind, the map and the aggregate table would disagree with the
	// dial about where the target is.
	out := postReset(t, storedSite(), map[string]any{"scenario": "current"})
	if len(out.Catchments) != 1 {
		t.Fatalf("expected 1 catchment, got %d", len(out.Catchments))
	}
	if got := out.Catchments[0].Ideal["npp"]; got != 200 {
		t.Errorf("catchment ideal npp = %v, want 200 (its own current)", got)
	}
}

func TestResetClearsStaleWarnings(t *testing.T) {
	site := storedSite()
	site.Indicators.Warnings = []string{"Herbivore consumption is higher than available biomass."}
	out := postReset(t, site, map[string]any{"scenario": "current"})
	if len(out.Indicators.Warnings) != 0 {
		t.Errorf("warnings survived a reset: %v", out.Indicators.Warnings)
	}
}

func TestResetDefaultsToCurrentWhenNoScenarioGiven(t *testing.T) {
	// The Indicators page has always sent no scenario and meant "current".
	out := postReset(t, storedSite(), map[string]any{})
	if got := out.Indicators.Ideal["npp"]; got != 259 {
		t.Errorf("ideal npp = %v, want 259 — an absent scenario must still mean current", got)
	}
}

func TestResetIsNotRegisteredOutsideDesktopMode(t *testing.T) {
	// The route must not exist in browser runtime: reaching it would mean the
	// user's site had been sent to the server, which is the one thing this
	// application does not do with sites.
	dir := t.TempDir()
	store, err := sites.NewStore(dir)
	if err != nil {
		t.Fatalf("site store: %v", err)
	}
	handler := NewHandler(nil, nil, store, config.Config{Port: 8080, DataDir: dir, Version: "test"}, nil)
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest(http.MethodPost, "/sites/any/indicators/reset", bytes.NewReader([]byte(`{}`)))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404 outside desktop mode, got %d", rec.Code)
	}
}
