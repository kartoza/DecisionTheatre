package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// Admission control: refuse work the server cannot do in time, instead of
// accepting all of it and doing all of it slowly.
//
// Measured on the deployment target (4 cores) with scripts/dtbench.py: at 32
// concurrent clients the API reached 18.5 s at p95 with zero errors. Zero
// errors sounds like the server coping. It is the opposite. Every request was
// accepted and queued, and the queue handed the overload back to clients as
// latency — so nobody was refused and nobody was served either. Meanwhile the
// health check answered in 7 ms, because health is free, which is how a server
// in that state can look fine on a dashboard while being unusable.
//
// A refused request is information: the client learns to back off, a browser
// shows an error instead of a spinner, and a crawler with any manners slows
// down. A slow request tells the client nothing, so it waits, and often
// retries on top of the work already in flight. That is the shape of an
// outage that needs no attacker.
//
// So: a fixed number of expensive requests run at once, a short queue absorbs
// bursts, and everything past that gets 503 with Retry-After immediately.
// Latency for the accepted work stays near what one request costs when the
// server is idle, which is the only latency anybody can use.

const (
	// concurrencyPerCPU is how many expensive requests run per core.
	//
	// The expensive endpoints are CPU- and IO-bound over SQLite, not waiting on
	// anything remote, so more concurrency than cores buys no throughput — it
	// only spreads the same total work over more requests, making all of them
	// slower and none of them finish sooner. One per core plus a little slack
	// for the IO wait is where throughput flattens.
	concurrencyPerCPU = 2

	// minConcurrency keeps a single-core container from serialising to one.
	minConcurrency = 4

	// queuePerSlot is the burst absorber, in requests per running slot.
	//
	// A quad-view page load fires four choropleth requests at once and a short
	// queue is what stops one of them being refused on an otherwise idle
	// server. Deep queues are the thing being fixed, so this is small: enough
	// for a page load, not enough to build up minutes of backlog.
	queuePerSlot = 3

	// maxQueueWait bounds how long a queued request waits for a slot.
	//
	// The depth limit alone is not enough, because it assumes every queued
	// request costs about the same. They do not: /api/choropleth with
	// valuesOnly takes 4.5 s and /api/scenarios takes 2 ms. This is the
	// backstop that keeps a queue of slow work from turning into a long wait,
	// whatever the depth says.
	maxQueueWait = 6 * time.Second

	// retryAfterSeconds is what a shed request is told to wait.
	//
	// Long enough that a client obeying it does not immediately re-add the
	// load that caused the shed, short enough that a real person reloading
	// gets served once the burst passes.
	retryAfterSeconds = 5
)

// admissionOutcome is why a request did or did not get a slot.
type admissionOutcome int

const (
	admitted admissionOutcome = iota
	shedQueueFull
	shedTimedOut
	clientLeft
)

// admissionController hands out a bounded number of concurrent slots.
type admissionController struct {
	slots    chan struct{}
	queued   atomic.Int64
	maxQueue int64
	maxWait  time.Duration

	// Counters for the log line; nothing pages on these yet, but a shed that
	// nobody can see is indistinguishable from a server that is not shedding.
	admittedCount atomic.Int64
	shedCount     atomic.Int64
}

func newAdmissionController() *admissionController {
	n := runtime.GOMAXPROCS(0) * concurrencyPerCPU
	if n < minConcurrency {
		n = minConcurrency
	}
	return &admissionController{
		slots:    make(chan struct{}, n),
		maxQueue: int64(n * queuePerSlot),
		maxWait:  maxQueueWait,
	}
}

// capacity reports how many requests run concurrently. For tests and logging.
func (c *admissionController) capacity() int { return cap(c.slots) }

// acquire takes a slot, waits briefly for one, or gives up.
//
// The fast path is a non-blocking send, so an idle server adds one channel
// operation per request and never touches the queue counter.
func (c *admissionController) acquire(ctx context.Context) admissionOutcome {
	select {
	case c.slots <- struct{}{}:
		c.admittedCount.Add(1)
		return admitted
	default:
	}

	// Full. Join the queue if there is room, and refuse at once if not —
	// refusing immediately is the point, since a request that will be refused
	// eventually may as well be refused before it occupies anything.
	if c.queued.Add(1) > c.maxQueue {
		c.queued.Add(-1)
		c.shedCount.Add(1)
		return shedQueueFull
	}
	defer c.queued.Add(-1)

	timer := time.NewTimer(c.maxWait)
	defer timer.Stop()

	select {
	case c.slots <- struct{}{}:
		c.admittedCount.Add(1)
		return admitted
	case <-ctx.Done():
		// The client hung up while queued. Not a shed: there is nobody to tell,
		// and counting it as one would make an ordinary page-navigation-away
		// look like overload.
		return clientLeft
	case <-timer.C:
		c.shedCount.Add(1)
		return shedTimedOut
	}
}

// release returns a slot.
func (c *admissionController) release() { <-c.slots }

// needsAdmission reports whether a path is expensive enough to be bounded.
//
// The allowlist is deliberately the cheap set rather than the expensive one.
// The failure mode of guessing wrong in this direction is that a cheap request
// occasionally queues; guessing wrong the other way leaves an expensive
// endpoint unbounded, which is the bug being fixed. A new handler is therefore
// bounded by default, and has to be named here to escape.
func needsAdmission(path string) bool {
	if !strings.HasPrefix(path, "/api/") {
		// Static assets and tiles are served from memory or an mbtiles read.
		// They are cheap per request, and bounding them would make the page
		// itself fail under a load the server can actually absorb.
		return false
	}
	switch path {
	case "/api/health", "/api/info", "/api/datapack/status":
		// Never shed. Health is how the container orchestrator decides whether
		// this process is alive: shedding it under load would get a coping
		// server killed and restarted, turning a slow minute into a real
		// outage. It is also cheap enough that it cannot itself be the problem.
		return false
	}
	return true
}

// admitRequests bounds concurrent expensive work and sheds the rest.
func admitRequests(next http.Handler) http.Handler {
	c := newAdmissionController()
	log.Printf("[admission] %d concurrent API requests, queue %d, max wait %s",
		c.capacity(), c.maxQueue, c.maxWait)
	return admitRequestsWith(c, next)
}

// admitRequestsWith is admitRequests with the controller supplied, so a test
// can set a capacity of one rather than however many cores the runner has.
func admitRequestsWith(c *admissionController, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !needsAdmission(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}

		switch c.acquire(r.Context()) {
		case admitted:
			defer c.release()
			next.ServeHTTP(w, r)

		case clientLeft:
			// Matches the convention in internal/api/cancel.go: a disconnect is
			// not an error, and must not land in the bucket someone pages on.
			w.WriteHeader(499)

		default:
			respondOverloaded(w, r)
		}
	})
}

// respondOverloaded writes the refusal.
//
// 503 rather than 429: 429 says this client asked too often, which may not be
// true — one polite client can be refused because of everyone else. 503 with
// Retry-After says the server is at capacity, which is what happened, and is
// the status crawlers and CDNs are documented to back off on.
func respondOverloaded(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfterSeconds))
	w.Header().Set("Content-Type", "application/json")
	// Never cache a refusal. Without this a shared cache could pin the 503 in
	// front of a server that recovered seconds later.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusServiceUnavailable)
	fmt.Fprintf(w, `{"error":"server at capacity, retry in %ds"}`+"\n", retryAfterSeconds)
	log.Printf("[admission] shed %s %s", r.Method, r.URL.Path)
}
