package server

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
)

// The server bound every interface — `Addr: fmt.Sprintf(":%d", port)` — while the
// comment three lines below asserted it "only listens on localhost", and used
// that false claim to justify disabling WriteTimeout entirely. Every endpoint is
// unauthenticated, so on a desktop install this published the whole API,
// including the routes that write to disk, to everyone on the user's network.

func TestMainServerBindsLoopbackByDefault(t *testing.T) {
	srv := newTestServer(t, true) // desktop build: the case that matters most
	srv.cfg.Port = 8080

	httpSrv := srv.newHTTPServer()

	if httpSrv.Addr != "127.0.0.1:8080" {
		t.Errorf("Addr = %q, want 127.0.0.1:8080", httpSrv.Addr)
	}
	if strings.HasPrefix(httpSrv.Addr, ":") {
		t.Errorf("Addr = %q binds every interface", httpSrv.Addr)
	}
}

func TestMainServerHonoursAnExplicitBindAddress(t *testing.T) {
	srv := newTestServer(t, false)
	srv.cfg.Port = 8080
	srv.cfg.BindAddress = "0.0.0.0"

	if got := srv.newHTTPServer().Addr; got != "0.0.0.0:8080" {
		t.Errorf("Addr = %q, want 0.0.0.0:8080 — the container asks for this explicitly", got)
	}
}

// A disabled write timeout means a stalled client holds a connection and its
// goroutine forever. The long downloads opt out individually instead; see
// allowLongDownload.
func TestMainServerHasAllTimeoutsSet(t *testing.T) {
	httpSrv := newTestServer(t, true).newHTTPServer()

	for _, c := range []struct {
		name string
		got  time.Duration
	}{
		{"ReadTimeout", httpSrv.ReadTimeout},
		{"WriteTimeout", httpSrv.WriteTimeout},
		{"IdleTimeout", httpSrv.IdleTimeout},
	} {
		if c.got <= 0 {
			t.Errorf("%s is %v; an unbounded timeout lets a stalled client hold a goroutine", c.name, c.got)
		}
	}
}

// The aux listeners set only IdleTimeout, so a client that opened a connection
// and stalled mid-request held it indefinitely.
func TestAuxTileServerHasAllTimeoutsSet(t *testing.T) {
	aux := newAuxTileServer(mux.NewRouter())

	for _, c := range []struct {
		name string
		got  time.Duration
	}{
		{"ReadTimeout", aux.ReadTimeout},
		{"WriteTimeout", aux.WriteTimeout},
		{"IdleTimeout", aux.IdleTimeout},
	} {
		if c.got <= 0 {
			t.Errorf("aux tile server %s is %v, want a bound", c.name, c.got)
		}
	}
}

// End to end: the listener the server would actually open must not answer on a
// routable address. This binds a real port rather than inspecting a struct field,
// so a future change that computes the address correctly and then ignores it
// still fails.
func TestListenerIsNotReachableOffLoopback(t *testing.T) {
	routable := routableIPv4(t)

	cfg := config.Config{Port: 0} // port 0: the OS picks a free one
	ln, err := net.Listen("tcp", cfg.ListenAddress())
	if err != nil {
		t.Fatalf("listening on %s: %v", cfg.ListenAddress(), err)
	}
	defer ln.Close() //nolint:errcheck

	port := ln.Addr().(*net.TCPAddr).Port

	// Loopback must work, or the application is broken.
	local, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 2*time.Second)
	if err != nil {
		t.Fatalf("could not reach the server on loopback: %v", err)
	}
	local.Close() //nolint:errcheck

	// The same port on this machine's routable address must not.
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(routable, strconv.Itoa(port)), 2*time.Second)
	if err == nil {
		conn.Close() //nolint:errcheck
		t.Errorf("the server accepted a connection on %s:%d; it is reachable from the network",
			routable, port)
	}
}

// routableIPv4 returns a non-loopback IPv4 address of this machine, skipping the
// test when there is none — a container with only loopback cannot demonstrate
// anything here.
func routableIPv4(t *testing.T) string {
	t.Helper()

	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Skipf("could not enumerate interfaces: %v", err)
	}
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() {
			continue
		}
		if ip4 := ipnet.IP.To4(); ip4 != nil {
			return ip4.String()
		}
	}
	t.Skip("no non-loopback IPv4 address on this machine")
	return ""
}

// The safe default is only safe if the deployment that needs the unsafe one asks
// for it, rather than the default being widened to suit the container.
func TestDeploymentConfigBindsExplicitly(t *testing.T) {
	for _, f := range []string{
		filepath.Join("..", "..", "deployments", "Dockerfile"),
		filepath.Join("..", "..", "deployments", "docker-compose.yaml"),
	} {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Errorf("could not read %s: %v", f, err)
			continue
		}
		if !strings.Contains(string(data), "0.0.0.0") {
			t.Errorf("%s does not pass --bind 0.0.0.0; the container would listen on "+
				"loopback only and nginx could not reach it", f)
		}
	}
}
