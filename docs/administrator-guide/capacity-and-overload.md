# Capacity and Overload

This page is about what happens when more traffic arrives than the server can
handle, and how it is configured to behave. It is written for whoever operates
the deployment.

The short version: the server refuses work it cannot do in time, rather than
accepting all of it and doing all of it slowly. If you see `429` and `503` in
the logs under load, that is the design working, not a fault.

## Why refusing is better than trying

A server with no limits does not fail when it runs out of capacity. It queues.
Every request is accepted, every request is eventually answered, and the
answers arrive later and later as the queue grows. Nothing reports an error, so
nothing looks wrong, while the site becomes unusable.

That was measured on a four-core instance with `scripts/dtbench.py`, before any
of the limits described below existed:

| Concurrent clients | 95th percentile response | Errors |
| ------------------ | ------------------------ | ------ |
| 8                  | 10.4 s                   | 0      |
| 32                 | 43.0 s                   | 0      |
| 64                 | 60.3 s                   | 0      |

Zero errors throughout. Latency rising in step with the load, without limit —
double the clients, double the wait. A monitoring dashboard watching error
rates would have shown a perfectly healthy server, and the health check
answered in milliseconds the whole time, because health checks are cheap and
have nothing to do with whether real work is getting done.

The same instance with the limits in place:

| Concurrent clients | 95th percentile response | Refused |
| ------------------ | ------------------------ | ------- |
| 8                  | 9.4 s                    | 0       |
| 32                 | 9.7 s                    | 96      |
| 64                 | 5.3 s                    | 2355    |

Response time now stops tracking the load. Past the point where the server is
full, additional clients are turned away in milliseconds instead of joining a
queue — which is why the figure at 64 clients is lower than at 32, and why
throughput went from 1.1 to 60 requests a second.

A refused request is information. The client learns to back off, the browser
shows an error instead of a spinner, and a well-behaved crawler slows down. A
slow request tells the client nothing at all, so it waits, and often retries on
top of the work already in flight.

## The three layers

Each layer handles something the others cannot. None of them is redundant.

### 1. Rate limits, in nginx

Configured in `deployments/nginx.conf`. Bounds how fast a single client may
ask.

- `/api/` — 10 requests a second sustained, bursts of 20 allowed immediately.
- Tiles and fonts — 100 a second, bursts of 200. Panning a map fires a lot of
  tile requests and must not be throttled.
- 24 concurrent connections per client address, everywhere.

Over the limit gets `429 Too Many Requests`.

A page load fires roughly a dozen API calls at once, which is why the burst
allowance exists. If ordinary use ever starts getting throttled, the burst is
the number to raise, not the rate.

!!! warning "Behind a CDN"
    The limits key on the client's IP address. If something else terminates
    connections in front of this nginx, it sees that thing's address instead
    and every visitor shares one bucket. Set `real_ip_header` and
    `set_real_ip_from` for the fronting proxy, or the limits will be wrong in
    both directions — throttling everyone at once, and never throttling an
    individual abuser.

### 2. Admission control, in the application

Configured in code, in `internal/server/admission.go`. Bounds how much work is
in flight from everyone at once.

The application runs two API requests per CPU core at a time, queues a short
burst behind that, and refuses anything further with `503 Service Unavailable`
and a `Retry-After` header. On the four-core deployment target that is 8
concurrent, a queue of 24, and a maximum six-second wait for a slot.

Rate limiting cannot do this job: a thousand distinct addresses each asking
politely still adds up to more work than four cores can do. Admission control
cannot do the rate limiter's job either, because a hundred thousand cheap
requests never trip it.

Two paths are never refused:

- `/api/health` — shedding it would make an orchestrator kill a server that was
  coping, turning a slow minute into a real outage.
- Static assets, tiles and the page itself — throttling those means a load the
  server could absorb still shows the user a broken site.

Everything else under `/api` is bounded, including endpoints added later. That
is deliberate: a new handler is limited unless somebody decides otherwise,
because the alternative is an expensive endpoint left unbounded by omission.

### 3. Memory limits, in compose

Configured in `deployments/docker-compose.yaml`.

`GOMEMLIMIT` gives the Go runtime a soft heap ceiling. Without it, the process
has no idea it is in a container: it grows the heap according to what it has
allocated, notices nothing as it approaches the cgroup limit, and gets
OOM-killed mid-request. With it, the garbage collector works progressively
harder as the heap approaches the number, trading CPU for staying alive.

`mem_limit` is the hard ceiling underneath which `GOMEMLIMIT` must sit, with
room to spare — `GOMEMLIMIT` governs the Go heap only, and the process also
holds SQLite page cache, memory-mapped tiles and thread stacks that it does not
count.

Swap is disabled for the container. Swapping a server this size does not rescue
it; it makes every request slow enough to time out while the health check keeps
answering, which is failure that looks like life.

## Crawlers

`robots.txt` asks crawlers to stay off `/api`, `/tiles` and `/data`, and offers
a `Crawl-delay`. The pages and the documentation stay open, because the project
should be findable.

That covers the crawlers that read it. For the ones that do not, nginx returns
`444` — connection closed, no response — to a list of declared AI training and
SEO crawler user agents requesting `/api`. They can still read the site; they
just cannot run full-dataset queries against it.

A user agent is self-declared and trivially changed, so this catches only the
honest-but-greedy. It is the cheap layer. The rate limits and admission control
are what hold when the user agent is a lie, and they do not care who is asking.

## Tuning

| Variable                  | Default | What it does                                 |
| ------------------------- | ------- | -------------------------------------------- |
| `DT_MEMORY_LIMIT`         | `8g`    | Hard memory ceiling for the app container    |
| `DT_GOMEMLIMIT`           | `6GiB`  | Soft heap ceiling; must stay well under it   |
| `DT_CPU_LIMIT`            | `4`     | CPU cores, which also sets API concurrency   |
| `DT_NGINX_MEMORY_LIMIT`   | `512m`  | Memory ceiling for nginx                     |

Set these in `deployments/.env`.

`DT_CPU_LIMIT` does double duty. Go sizes `GOMAXPROCS` from the container's CPU
limit, and admission control sizes itself from `GOMAXPROCS`, so raising the CPU
allowance raises how many requests the application will accept at once. On a
bigger machine, raise it. Raising it beyond the cores actually available makes
the server accept more work than it can do, which is the behaviour these limits
exist to prevent.

The rate limits are in `deployments/nginx.conf` and need an nginx reload rather
than a restart:

```bash
docker compose -f deployments/docker-compose.yaml exec nginx nginx -s reload
```

Always check the file parses before reloading a production instance:

```bash
docker compose -f deployments/docker-compose.yaml exec nginx nginx -t
```

## Checking it yourself

`scripts/dtbench.py` produces the tables above. It can point at any running
instance, including production, and records every run so a change can be
compared against the whole history rather than one hand-picked baseline.

```bash
python3 scripts/dtbench.py run --target https://your-instance --label "after-tuning"
```

See [Benchmarking](../developer-guide/benchmarking.md) for the details.

!!! warning "Do not load-test production during working hours"
    The load phase deliberately saturates the server. That is the point of it,
    and the limits described here mean it will refuse requests while it runs —
    including requests from real users.

## What this does not fix

These limits keep the server up and keep its response time bounded. They do not
make it fast.

The underlying cost is unchanged: `/api/choropleth` still takes about 4.5
seconds and returns about 14 MB, because it queries the full dataset. That is
why the "after" table still shows a 95th percentile of several seconds — the
server is no longer making things worse under load, but a single request was
never quick to begin with. Caching those responses is a separate piece of work.
