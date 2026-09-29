package server

import (
	"net/http"
	"strings"
)

// robotsTxt is what crawlers are asked to respect.
//
// Without a robots.txt, the SPA fallback answered /robots.txt with a page of
// HTML — a 200 containing no directives, which a crawler reads as "no rules
// here" and proceeds accordingly. So the site had the strongest possible
// invitation to crawl everything, by accident.
//
// The rules follow the cost. /api is the expensive surface: /api/choropleth
// returns 14.7 MB after 4.5 s of work, and every one of those requests is a
// full-dataset query. There is nothing there for a crawler anyway — it is
// numbers for a map the crawler is not drawing — so disallowing it costs no
// discoverability at all. The pages and the documentation stay open, because
// people should be able to find this.
//
// Crawl-delay is not in the original robots specification and Google ignores
// it, but Bing, Yandex and a good number of the smaller crawlers honour it,
// and those are exactly the ones with no per-site politeness tuning. It costs
// two lines to be worth having for the ones that read it.
//
// None of this stops a crawler that ignores robots.txt. It is the polite half
// of the answer; admission control in admission.go and the rate limits in
// deployments/nginx.conf are the half that does not depend on anyone's
// cooperation. Ask first, enforce regardless.
const robotsTxt = `# Decision Theatre
#
# The API is not for crawling: every /api request runs a query over the full
# dataset and returns megabytes of numbers that mean nothing without the map
# they belong to. Crawl the pages and the docs instead.

User-agent: *
Disallow: /api/
Disallow: /tiles/
Disallow: /data/
Crawl-delay: 10

Allow: /
Allow: /docs/
`

// handleRobots serves robots.txt.
//
// Registered explicitly because the SPA fallback would otherwise claim it, and
// a crawler that asks for the rules must get the rules rather than the
// application.
func handleRobots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// A day: long enough to save the repeated fetch, short enough that a change
	// to the rules takes effect without waiting for a cache somewhere to forget.
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = strings.NewReader(robotsTxt).WriteTo(w)
}
