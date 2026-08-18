# Vendored page backgrounds

These were hotlinked directly from `images.unsplash.com` on every page load, which
made three pages depend on a third-party host at runtime: it can rate-limit, change
what a URL returns, or go away, and it sees the IP of every visitor to those pages.
They are served from our own bundle now.

| File | Used by | Source |
|---|---|---|
| `savanna-sunset.webp` | `SitesPage.tsx` | `https://images.unsplash.com/photo-1501854140801-50d01698950b` |
| `mountain-lake.webp` | `AboutPage.tsx`, `DownloadPage.tsx` | `https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05` |

Retrieved 2026-08-17 with `?fm=webp&fit=crop&w=1920&q=50`.

## Licence

Unsplash Licence — <https://unsplash.com/license>. Free for commercial and
non-commercial use with no permission required; the licence does not permit
compiling photos to replicate a competing service, which is not what this is.
Attribution is not required but is appreciated, and could not be resolved here:
`https://unsplash.com/photos/<id>` needs the slug as well as the id, so the
photographer's name is not recoverable from the URL alone. If someone has API
access, add the names here.

## Format and size

webp at `w=1920&q=50`, chosen by measurement rather than by habit. Unsplash's own
`auto=format` pipeline is well tuned, and webp at `q=75` came out *larger* than
their JPEG (708,978 against 579,422 bytes):

| | bytes |
|---|---|
| jpg `auto=format` w=2000 q=80 (what was hotlinked) | 579,422 |
| webp w=2000 q=75 | 708,978 |
| jpg w=1920 q=70 | 519,495 |
| webp w=1920 q=60 | 514,848 |
| **webp w=1920 q=50** | **405,200** |

q=50 is safe because both are full-bleed backgrounds with an opaque overlay `Box`
composited on top — no detail in them is ever read directly.

Re-exporting at a different size or quality is fine; keep the table honest if you
do.
