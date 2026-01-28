# REQ-001: Embedded Web Server

| Field | Value |
|-------|-------|
| **Component** | Backend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I launch the application, I should have a fully functional web interface served from the embedded HTTP server without needing any external web server. |
| **Importance** | Critical |

## Wireframe

```
┌─────────────────────────────────────┐
│  Terminal                           │
│  $ ./decision-theatre --port 8080   │
│  Server listening on :8080          │
│  Open http://localhost:8080         │
│                                     │
│  (Browser opens automatically)      │
└─────────────────────────────────────┘
```

## Implementation Details

- The Go binary embeds a complete HTTP server using `net/http` and `gorilla/mux`
- All static frontend assets (HTML, JS, CSS, images) are embedded using Go's `//go:embed` directive
- The server serves the React SPA at the root path `/`
- API endpoints are available under `/api/`
- Vector tile endpoints are available under `/tiles/`
- The server supports graceful shutdown on SIGINT/SIGTERM
- Default port is 8080, configurable via `--port` flag
- Read/write/idle timeouts are configured for security
- SPA fallback routing ensures client-side routes work correctly

### Key Files

- `internal/server/server.go` - HTTP server implementation
- `main.go` - Application entry point with flag parsing
