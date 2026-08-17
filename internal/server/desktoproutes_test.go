package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
)

// /api/dialog/open-file calls zenity, which opens a native file picker on
// whatever desktop session the process is attached to and blocks until a human
// answers. The route was registered unconditionally, and nginx proxies every
// path, so on the hosted deployment a stranger could open a window on the
// server's desktop — and each call held a server goroutine for as long as the
// dialog stood open.
//
// It only means anything in the desktop build, so in server mode it must not
// exist at all.

func newTestServer(t *testing.T, desktop bool) *Server {
	t.Helper()

	srv, err := New(config.Config{
		Port:        0,
		DataDir:     t.TempDir(),
		Version:     "test",
		DesktopMode: desktop,
	})
	if err != nil {
		t.Fatalf("New(DesktopMode=%v): %v", desktop, err)
	}
	return srv
}

// hasRoute reports whether the router has a route with the given path template.
//
// The route table is inspected rather than a request issued, deliberately: if the
// gate regressed, sending a request would call zenity and block on a real file
// picker until a human closed it, so the test would hang instead of failing.
func hasRoute(t *testing.T, srv *Server, template string) bool {
	t.Helper()

	found := false
	err := srv.router.Walk(func(route *mux.Route, _ *mux.Router, _ []*mux.Route) error {
		if tmpl, err := route.GetPathTemplate(); err == nil && tmpl == template {
			found = true
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the router: %v", err)
	}
	return found
}

func TestFileDialogRouteAbsentInServerMode(t *testing.T) {
	srv := newTestServer(t, false)

	if hasRoute(t, srv, "/api/dialog/open-file") {
		t.Error("the file dialog route is registered in server mode; " +
			"a remote caller could open a window on the host's desktop")
	}
}

// And the path really is unrouted, so it falls through rather than answering.
func TestFileDialogPathIsNotHandledInServerMode(t *testing.T) {
	srv := newTestServer(t, false)

	req := httptest.NewRequest(http.MethodPost, "/api/dialog/open-file", nil)
	rec := httptest.NewRecorder()
	srv.router.ServeHTTP(rec, req)

	// The SPA fallback answers anything unrouted with HTML, so a JSON body here
	// would mean the dialog handler ran.
	if ct := rec.Header().Get("Content-Type"); strings.Contains(ct, "application/json") {
		t.Errorf("something answered with JSON: %d %s", rec.Code, rec.Body.String())
	}
}

func TestFileDialogRouteRegisteredInDesktopMode(t *testing.T) {
	srv := newTestServer(t, true)

	if !hasRoute(t, srv, "/api/dialog/open-file") {
		t.Error("the file dialog route is missing in desktop mode")
	}
}

// The zero value of Config must give the server build. A caller that forgets to
// set DesktopMode should not silently get the desktop routes.
func TestZeroConfigIsServerMode(t *testing.T) {
	var cfg config.Config
	if cfg.DesktopMode {
		t.Error("the zero value of Config enables desktop mode; it must default to the server build")
	}
}
