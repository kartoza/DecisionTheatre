package config

import (
	"strconv"
	"testing"
)

// The server bound 0.0.0.0 while a comment three lines below asserted it "only
// listens on localhost" — and that false claim was used to justify disabling
// WriteTimeout. Every endpoint is unauthenticated, so on a desktop install this
// published the whole API, including the routes that write to disk, to everyone
// on the user's network.

// The zero value has to be the safe one. A caller that never thinks about
// BindAddress must not end up publishing to the network.
func TestZeroConfigBindsLoopback(t *testing.T) {
	var cfg Config
	cfg.Port = 8080

	if got := cfg.ListenAddress(); got != "127.0.0.1:8080" {
		t.Errorf("ListenAddress() = %q for a zero-value BindAddress, want 127.0.0.1:8080", got)
	}
	if DefaultBindAddress != "127.0.0.1" {
		t.Errorf("DefaultBindAddress = %q, want 127.0.0.1", DefaultBindAddress)
	}
}

// An empty address must never produce a wildcard bind, which is what
// fmt.Sprintf(":%d", port) did.
func TestListenAddressIsNeverWildcardByDefault(t *testing.T) {
	for _, port := range []int{0, 80, 8080, 65535} {
		cfg := Config{Port: port}
		if got := cfg.ListenAddress(); got[0] == ':' {
			t.Errorf("ListenAddress() = %q, which binds every interface", got)
		}
	}
}

func TestListenAddressHonoursAnExplicitAddress(t *testing.T) {
	cases := map[string]struct {
		bind string
		port int
		want string
	}{
		"wildcard, as the container asks for": {"0.0.0.0", 8080, "0.0.0.0:8080"},
		"one specific interface":              {"192.168.1.10", 8080, "192.168.1.10:8080"},
		"loopback by name":                    {"localhost", 3000, "localhost:3000"},
		// JoinHostPort brackets an IPv6 literal; a bare colon-joined form would
		// be unparseable as an address.
		"ipv6 loopback":  {"::1", 8080, "[::1]:8080"},
		"ipv6 wildcard":  {"::", 8080, "[::]:8080"},
		"explicit local": {"127.0.0.1", 8080, "127.0.0.1:8080"},
	}

	for name, c := range cases {
		cfg := Config{BindAddress: c.bind, Port: c.port}
		if got := cfg.ListenAddress(); got != c.want {
			t.Errorf("%s: ListenAddress() = %q, want %q", name, got, c.want)
		}
	}
}

// The auxiliary tile listeners bound the wildcard separately, so they need the
// same treatment as the main port rather than their own rule.
func TestListenAddressForPortUsesTheSameInterface(t *testing.T) {
	cfg := Config{Port: 8080}
	for i := 1; i <= 3; i++ {
		want := "127.0.0.1:" + strconv.Itoa(8080+i)
		if got := cfg.ListenAddressForPort(8080 + i); got != want {
			t.Errorf("ListenAddressForPort(%d) = %q, want %q", 8080+i, got, want)
		}
	}

	wide := Config{BindAddress: "0.0.0.0", Port: 8080}
	if got := wide.ListenAddressForPort(8081); got != "0.0.0.0:8081" {
		t.Errorf("an explicit wildcard should carry to the aux ports, got %q", got)
	}
}

// LocalURL is what this process uses to reach its own server: the webview loads
// it and the readiness probe polls it. A wildcard is not a usable destination,
// and a specific interface means localhost is not listening.
func TestLocalURL(t *testing.T) {
	cases := map[string]struct {
		bind string
		want string
	}{
		"default is loopback":     {"", "http://localhost:8080"},
		"wildcard is not dialled": {"0.0.0.0", "http://localhost:8080"},
		"ipv6 wildcard":           {"::", "http://localhost:8080"},
		"ipv6 wildcard bracketed": {"[::]", "http://localhost:8080"},
		"explicit loopback":       {"127.0.0.1", "http://127.0.0.1:8080"},
		// Bound to one interface, so that is the only address that answers.
		"specific interface": {"192.168.1.10", "http://192.168.1.10:8080"},
	}

	for name, c := range cases {
		cfg := Config{BindAddress: c.bind, Port: 8080}
		if got := cfg.LocalURL(); got != c.want {
			t.Errorf("%s: LocalURL() = %q, want %q", name, got, c.want)
		}
	}
}
