#!/usr/bin/env python3
"""Static file server + reverse proxy for the mbtiles testbed.

Serves the generated preview page and style.json from STATIC_DIR, and
transparently proxies every /services/... request through to the
mbtileserver process. Putting both behind one origin means the browser
never has to make a cross-origin request for tiles, so no CORS headers
are needed on mbtileserver's side (it doesn't send any).

Configured entirely via environment variables so the calling shell
script doesn't need to fight over an argv convention with either half
of what it's launching:
  MBTILES_TESTBED_PORT     port this server listens on
  MBTILES_UPSTREAM_PORT    port mbtileserver is listening on
  MBTILES_TESTBED_STATIC_DIR   directory to serve static files from
"""

import http.server
import os
import sys
import urllib.error
import urllib.request

PUBLIC_PORT = int(os.environ["MBTILES_TESTBED_PORT"])
UPSTREAM_PORT = int(os.environ["MBTILES_UPSTREAM_PORT"])
STATIC_DIR = os.environ["MBTILES_TESTBED_STATIC_DIR"]

HOP_BY_HOP_HEADERS = {"transfer-encoding", "connection", "keep-alive"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def do_GET(self):
        if self.path.startswith("/services"):
            self._proxy()
        else:
            super().do_GET()

    def _proxy(self):
        # Forwarding the original Host header (rather than letting urllib
        # compute one for the upstream address) is what makes this work:
        # mbtileserver builds the "tiles" URLs in its TileJSON responses
        # from the incoming Host header, so it ends up advertising tile
        # URLs on the *public* port, keeping every request same-origin.
        url = f"http://127.0.0.1:{UPSTREAM_PORT}{self.path}"
        req = urllib.request.Request(url, headers={"Host": self.headers.get("Host", "")})
        try:
            with urllib.request.urlopen(req) as resp:
                self._relay(resp.status, resp.getheaders(), resp.read())
        except urllib.error.HTTPError as e:
            self._relay(e.code, e.headers.items() if e.headers else [], e.read())
        except urllib.error.URLError as e:
            self.send_error(502, f"mbtileserver unreachable: {e.reason}")

    def _relay(self, status, headers, body):
        self.send_response(status)
        for key, value in headers:
            if key.lower() not in HOP_BY_HOP_HEADERS:
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PUBLIC_PORT), Handler)
    server.serve_forever()
