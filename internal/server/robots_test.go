package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRobotsIsServedAsRulesNotAsThePage(t *testing.T) {
	// The bug this route fixes: the SPA fallback answered /robots.txt with
	// index.html. A 200 full of HTML parses as a robots file with no rules in
	// it, so the site read as fully crawlable to anything that asked.
	rec := httptest.NewRecorder()
	handleRobots(rec, httptest.NewRequest("GET", "/robots.txt", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("Content-Type %q; a crawler wants rules, not a document", ct)
	}
	body := rec.Body.String()
	if strings.Contains(strings.ToLower(body), "<html") {
		t.Fatal("robots.txt is serving the application")
	}
	if !strings.Contains(body, "User-agent: *") {
		t.Error("no User-agent line, so nothing below it applies to anyone")
	}
}

func TestTheExpensiveSurfaceIsDisallowed(t *testing.T) {
	// /api/choropleth is 14.7 MB after 4.5 s of full-dataset query. It is the
	// path that has to be closed, and there is nothing in it for a crawler.
	for _, path := range []string{"/api/", "/tiles/", "/data/"} {
		if !strings.Contains(robotsTxt, "Disallow: "+path) {
			t.Errorf("%s is not disallowed", path)
		}
	}
}

func TestThePagesStayCrawlable(t *testing.T) {
	// Blocking everything would keep the server up by making the site
	// undiscoverable, which is not the trade being made.
	if strings.Contains(robotsTxt, "Disallow: /\n") {
		t.Error("the whole site is disallowed; people should still be able to find it")
	}
	if !strings.Contains(robotsTxt, "Allow: /docs/") {
		t.Error("the documentation is not explicitly crawlable")
	}
}

func TestRobotsBeatsTheSPAFallbackInTheRouteTable(t *testing.T) {
	// mux matches in order, so this asserts registration order rather than the
	// handler: getting it wrong reintroduces exactly the bug above, silently.
	srv := newTestServer(t, false)
	rec := httptest.NewRecorder()
	srv.rootHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/robots.txt", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "User-agent") {
		t.Errorf("the SPA fallback claimed /robots.txt; body starts %.60q", rec.Body.String())
	}
}
