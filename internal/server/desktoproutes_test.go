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
	err := srv.currentRouter().Walk(func(route *mux.Route, _ *mux.Router, _ []*mux.Route) error {
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
	srv.currentRouter().ServeHTTP(rec, req)

	// Unrouted /api paths now answer 404 in JSON rather than falling through to
	// the SPA, so "is it JSON" is no longer the signal — what matters is that the
	// answer is a not-found rather than anything the dialog handler produced.
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for an unrouted API path", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "path") {
		t.Errorf("the response looks like a file dialog result: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "no such endpoint") {
		t.Errorf("body = %s, want the not-found error", rec.Body.String())
	}
}

func TestFileDialogRouteRegisteredInDesktopMode(t *testing.T) {
	srv := newTestServer(t, true)

	if !hasRoute(t, srv, "/api/dialog/open-file") {
		t.Error("the file dialog route is missing in desktop mode")
	}
}

// /api/datapack/install takes a path on the host's filesystem and replaces the
// contents of the data directory with whatever it finds there. The path can only
// come from the file dialog, which is desktop-only, so there was no way to use
// this legitimately on a hosted deployment — and no authentication stopping
// anyone using it otherwise.
func TestDatapackInstallRouteAbsentInServerMode(t *testing.T) {
	srv := newTestServer(t, false)

	if hasRoute(t, srv, "/api/datapack/install") {
		t.Error("the datapack install route is registered in server mode; " +
			"an unauthenticated caller could replace the data directory")
	}
}

func TestDatapackInstallRouteRegisteredInDesktopMode(t *testing.T) {
	srv := newTestServer(t, true)

	if !hasRoute(t, srv, "/api/datapack/install") {
		t.Error("the datapack install route is missing in desktop mode; " +
			"the setup guide needs it")
	}
}

// Serving the pack and the installers is what the hosted deployment is for, so
// gating must not catch them. These read; they do not write.
func TestPublicDatapackRoutesSurviveInServerMode(t *testing.T) {
	srv := newTestServer(t, false)

	for _, path := range []string{
		"/api/datapack/status",
		"/api/datapack/download-info",
		"/api/datapack/download",
		"/api/executables/info",
		"/api/executables/download/{platform}",
	} {
		if !hasRoute(t, srv, path) {
			t.Errorf("%s is missing in server mode; the hosted deployment serves it", path)
		}
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
