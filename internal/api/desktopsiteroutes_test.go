package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/sites"
)

// A user's own sites belong in their browser. The client honours that — in
// browser runtime every site create, read, update and delete goes to the
// dt-sites localStorage key with no fallthrough to the API — but the server
// registered the site CRUD for everyone regardless, putting an unauthenticated
// write-to-disk API on a deployment that nginx proxies wholesale.
//
// These tests pin both halves: the desktop-only routes must be absent in server
// mode, and the routes a browser session genuinely calls must not be.

// routerFor builds a router in the requested mode. The stores are nil: route
// registration does not touch them, and a handler that did would be a fault
// worth failing on.
func routerFor(t *testing.T, desktop bool) *mux.Router {
	t.Helper()

	dir := t.TempDir()
	siteStore, err := sites.NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	h := NewHandler(nil, nil, siteStore, config.Config{
		Port:        0,
		DataDir:     dir,
		Version:     "test",
		DesktopMode: desktop,
	}, nil)
	r := mux.NewRouter()
	h.RegisterRoutes(r)
	return r
}

// registeredRoutes returns "METHOD /path" for every route in the table.
//
// The table is inspected rather than requests issued, deliberately: several of
// these handlers write to disk or block, so a regression must fail as a missing
// route rather than by running the thing under test.
func registeredRoutes(t *testing.T, r *mux.Router) map[string]bool {
	t.Helper()

	out := map[string]bool{}
	err := r.Walk(func(route *mux.Route, _ *mux.Router, _ []*mux.Route) error {
		tmpl, err := route.GetPathTemplate()
		if err != nil {
			return nil // a route without a path template cannot be one of ours
		}
		methods, err := route.GetMethods()
		if err != nil || len(methods) == 0 {
			out["ANY "+tmpl] = true
			return nil
		}
		for _, m := range methods {
			out[m+" "+tmpl] = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the router: %v", err)
	}
	return out
}

// desktopOnly is every route that exists solely for the desktop build.
var desktopOnly = []string{
	"POST /sites",
	"PUT /sites/{id}",
	"PATCH /sites/{id}",
	"DELETE /sites/{id}",
	"POST /sites/{id}/indicators/reset",
	"POST /sites/{id}/boundary/union/{catchmentId}",
	"POST /sites/{id}/boundary/difference/{catchmentId}",
	"GET /sites",
	"GET /sites/{id}",
}

// sharedRoutes is every site route a browser-runtime session really calls. They
// take runtime:"browser" with the site in the request body and return before
// touching the store, so they must stay available to everyone. Gating one of
// these by mistake would break the hosted application outright.
var sharedRoutes = []string{
	"GET /sites/{id}/indicators",
	"POST /sites/{id}/indicators",
	"PATCH /sites/{id}/indicators",
	"GET /sites/{id}/catchments",
	"POST /sites/{id}/catchments",
	"GET /sites/{id}/whiskers",
	"POST /sites/{id}/whiskers",
	"GET /sites/{id}/summary",
	"POST /sites/{id}/summary",
	"POST /sites/dissolve-catchments",
}

func TestDesktopOnlySiteRoutesAbsentInServerMode(t *testing.T) {
	got := registeredRoutes(t, routerFor(t, false))

	for _, route := range desktopOnly {
		if got[route] {
			t.Errorf("%s is registered in server mode; "+
				"no browser client calls it and it reaches the site store", route)
		}
	}
}

func TestDesktopOnlySiteRoutesPresentInDesktopMode(t *testing.T) {
	got := registeredRoutes(t, routerFor(t, true))

	for _, route := range desktopOnly {
		if !got[route] {
			t.Errorf("%s is missing in desktop mode; the desktop build needs it", route)
		}
	}
}

// The point of the change is the gate, not a smaller API. Everything a browser
// session calls must survive in both modes.
func TestSharedSiteRoutesPresentInBothModes(t *testing.T) {
	for _, mode := range []struct {
		name    string
		desktop bool
	}{{"server", false}, {"desktop", true}} {
		got := registeredRoutes(t, routerFor(t, mode.desktop))

		for _, route := range sharedRoutes {
			if !got[route] {
				t.Errorf("%s mode: %s is missing; browser-runtime sessions call it",
					mode.name, route)
			}
		}
	}
}

// Gating must not remove anything else. Whatever the two modes differ by, that
// difference is exactly the desktop-only list — so a route quietly added to the
// gated block, or dropped from the shared one, shows up here.
func TestServerAndDesktopModeDifferByExactlyTheDesktopOnlyRoutes(t *testing.T) {
	server := registeredRoutes(t, routerFor(t, false))
	desktop := registeredRoutes(t, routerFor(t, true))

	expected := map[string]bool{}
	for _, route := range desktopOnly {
		expected[route] = true
	}

	var unexpected, missing []string
	for route := range desktop {
		if !server[route] && !expected[route] {
			unexpected = append(unexpected, route)
		}
	}
	for route := range expected {
		if !desktop[route] {
			missing = append(missing, route)
		}
	}
	// A route present in server mode but not desktop mode would be stranger
	// still: the desktop build is meant to be a superset.
	var serverOnly []string
	for route := range server {
		if !desktop[route] {
			serverOnly = append(serverOnly, route)
		}
	}

	sort.Strings(unexpected)
	sort.Strings(missing)
	sort.Strings(serverOnly)

	if len(unexpected) > 0 {
		t.Errorf("desktop mode adds routes that are not on the desktop-only list: %s\n"+
			"if these are desktop-only, add them to the list and say why; "+
			"if a browser session calls them, they must not be gated",
			strings.Join(unexpected, ", "))
	}
	if len(missing) > 0 {
		t.Errorf("on the desktop-only list but not registered in desktop mode: %s",
			strings.Join(missing, ", "))
	}
	if len(serverOnly) > 0 {
		t.Errorf("registered in server mode but not desktop mode: %s",
			strings.Join(serverOnly, ", "))
	}
}

// The gate is only worth anything if a request actually fails to reach the
// store. This is the end-to-end shape of the exposure: create a site file on
// disk, then try to delete it over HTTP the way a stranger would.
func TestServerModeRequestCannotDeleteASiteFromDisk(t *testing.T) {
	dir := t.TempDir()
	siteStore, err := sites.NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	site, err := siteStore.Create(&sites.Site{Title: "someone else's work"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	h := NewHandler(nil, nil, siteStore, config.Config{
		Port: 0, DataDir: dir, Version: "test", DesktopMode: false,
	}, nil)
	r := mux.NewRouter()
	h.RegisterRoutes(r)

	req := httptest.NewRequest(http.MethodDelete, "/sites/"+site.ID, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code == http.StatusOK {
		t.Errorf("DELETE /sites/%s answered 200 in server mode", site.ID)
	}

	// The file is what matters, not the status code.
	if _, err := siteStore.Get(site.ID); err != nil {
		t.Errorf("the site was deleted by an unauthenticated request: %v", err)
	}
	if _, err := filepath.Glob(filepath.Join(dir, "sites", "*.json")); err != nil {
		t.Fatalf("glob: %v", err)
	}
}

// The gate is only as good as the flag that drives it, and the flag comes from
// the deployment config rather than from code: DesktopMode is !*headless, so a
// hosted deployment that stops passing --headless silently re-opens every route
// above without a line of Go changing.
//
// Both files are checked because either one alone can launch the container.
func TestDeploymentConfigRunsInServerMode(t *testing.T) {
	for _, f := range []string{
		filepath.Join("..", "..", "deployments", "Dockerfile"),
		filepath.Join("..", "..", "deployments", "docker-compose.yaml"),
	} {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Errorf("could not read %s: %v", f, err)
			continue
		}
		if !strings.Contains(string(data), "--headless") {
			t.Errorf("%s does not pass --headless, so the container would run in "+
				"desktop mode and expose the site CRUD to the internet", f)
		}
	}
}

// And the same request in desktop mode does reach the store — otherwise the
// test above would pass with the routes broken for everybody.
func TestDesktopModeRequestCanDeleteASite(t *testing.T) {
	dir := t.TempDir()
	siteStore, err := sites.NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	site, err := siteStore.Create(&sites.Site{Title: "my own work"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	h := NewHandler(nil, nil, siteStore, config.Config{
		Port: 0, DataDir: dir, Version: "test", DesktopMode: true,
	}, nil)
	r := mux.NewRouter()
	h.RegisterRoutes(r)

	req := httptest.NewRequest(http.MethodDelete, "/sites/"+site.ID, nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK && rec.Code != http.StatusNoContent {
		t.Fatalf("DELETE in desktop mode answered %d: %s", rec.Code, rec.Body.String())
	}
	if _, err := siteStore.Get(site.ID); err == nil {
		t.Error("the site survived a delete in desktop mode")
	}
}
