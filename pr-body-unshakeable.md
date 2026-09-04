Server had no limits on it. Under load it queued instead of refusing, so
overload came back as latency and nothing showed up as an error. On 4 cores at
64 clients: p95 went from 60.3 s to 5.3 s, and throughput from 1.1 to 60 rps.

## Changed

1. Bounded API concurrency to 2 per core, short queue, then 503 with Retry-After
2. Health and static assets never refused, so a busy server does not get restarted
3. New API endpoints are bounded by default, you have to opt out
4. Added nginx rate limits, 10/s to /api with burst 20, 100/s for tiles
5. Added 24 connections per client
6. Cut proxy timeouts from 300 s to 90 s on /api and 120 s elsewhere
7. Added robots.txt, we had none and the SPA was serving HTML for it
8. Blocked declared AI and SEO crawlers from /api in nginx
9. Wrapped the 4 unprotected background goroutines so a panic cannot kill the process
10. Made /api/precalculate/full compute once for everyone instead of once per caller
11. Added GOMEMLIMIT and a container memory limit, turned off swap
12. Added a compose healthcheck, restart only catches a process that exited
13. Replaced the Go benchmark tool with scripts/dtbench.py, 12433 lines out
14. Added a load phase to it, the old one had concurrency out of scope
15. Records every run in SQLite and compares against the whole history
16. Added dt benchmark, make benchmark and nix run .#benchmark
17. Added a PDF report and xdg-open it when done
18. Stamped the git commit into the build and reported it on /api/info
19. Benchmark records the commit the server reports, not the one we have checked out
20. Added dt benchmark-regressions to find where a measurement changed and name the commit
21. Skip the load phase against remote targets unless you ask for it
22. Added an admin page on capacity and overload
23. Rewrote the benchmarking page
24. Bumped to 2.9.0

## Testing

Full Go suite, 41 python tests, nginx -t against the real file, gofmt,
sync-flake --check. Rate limits, crawler blocking and robots.txt tested end to
end through a container in front of a running server. Before and after numbers
measured twice each because the first pair looked like a regression at low
concurrency and turned out to be the machine.

## Before merge

1. deployments/.env.example needs DT_MEMORY_LIMIT, DT_GOMEMLIMIT, DT_CPU_LIMIT
   and DT_NGINX_MEMORY_LIMIT added by hand. My sandbox masks dotenv files with a
   device node so I could not edit it. Compose defaults apply until then.
2. This does not make anything faster. /api/choropleth is still 4.5 s and 14 MB
   because it queries the whole dataset. Caching it is a separate job.
3. bench-sweep is gone with the Go tool. benchmark-regressions answers what it
   was usually asked without rebuilding, but say if you want the real sweep back.
4. Production is on 2.6.0 and reports no commit, so benchmark runs against it
   cannot be tied to a commit until it is redeployed.
5. Sits on top of the flat dial branch, merge that one first.
