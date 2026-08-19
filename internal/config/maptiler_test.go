package config

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

// The MapTiler key used to be a string literal in the source, so it was in the
// repository, in every release binary and in every data pack — see issue #31.
// It now comes from configuration, and the property that matters is not merely
// that a configured key is used, but that an unconfigured one produces no
// request at all rather than a request with nothing after "key=". MapTiler
// answers that with 403, which surfaces to a user as a map with no labels and
// nothing anywhere pointing at the setting that is missing.

func TestMapTilerGlyphURLUsesConfiguredKey(t *testing.T) {
	cfg := Config{MapTilerKey: "test-key-123"}

	got, ok := cfg.MapTilerGlyphURL("Open Sans Regular", "0-255")
	if !ok {
		t.Fatal("MapTilerGlyphURL reported no key, but one is configured")
	}

	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("built an unparseable URL %q: %v", got, err)
	}
	if u.Host != "api.maptiler.com" {
		t.Errorf("host = %q, want api.maptiler.com", u.Host)
	}
	if key := u.Query().Get("key"); key != "test-key-123" {
		t.Errorf("key = %q, want the configured value", key)
	}
	if !strings.Contains(u.Path, "0-255") {
		t.Errorf("path %q does not name the requested range", u.Path)
	}
}

func TestMapTilerGlyphURLNoKeyProducesNoURL(t *testing.T) {
	// Whitespace counts as absent: a key pasted into a compose file or a
	// settings.json by hand collects a trailing newline easily, and " " must not
	// be mistaken for a usable credential.
	for name, key := range map[string]string{
		"empty":       "",
		"spaces":      "   ",
		"newlineOnly": "\n",
	} {
		t.Run(name, func(t *testing.T) {
			cfg := Config{MapTilerKey: key}

			got, ok := cfg.MapTilerGlyphURL("Open Sans Regular", "0-255")
			if ok {
				t.Fatalf("reported a usable key for %q", key)
			}
			if got != "" {
				t.Fatalf("returned %q; an unconfigured key must yield no URL at all, "+
					"least of all one ending in key=", got)
			}
		})
	}
}

func TestMapTilerGlyphURLTrimsKey(t *testing.T) {
	cfg := Config{MapTilerKey: "  test-key-123\n"}

	got, ok := cfg.MapTilerGlyphURL("Open Sans Regular", "0-255")
	if !ok {
		t.Fatal("a key with surrounding whitespace was treated as absent")
	}
	u, _ := url.Parse(got)
	if key := u.Query().Get("key"); key != "test-key-123" {
		t.Errorf("key = %q, want it trimmed", key)
	}
}

// fontstack and range come straight off the request path, so a crafted font name
// must not be able to add parameters of its own to the upstream query string.
func TestMapTilerGlyphURLEscapesPathSegments(t *testing.T) {
	cfg := Config{MapTilerKey: "real-key"}

	got, ok := cfg.MapTilerGlyphURL("Evil?key=stolen&x", "0-255#frag")
	if !ok {
		t.Fatal("MapTilerGlyphURL reported no key, but one is configured")
	}
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("built an unparseable URL %q: %v", got, err)
	}
	if key := u.Query().Get("key"); key != "real-key" {
		t.Errorf("key = %q; the font name overrode the configured key", key)
	}
	if u.Fragment != "" {
		t.Errorf("fragment = %q; the range escaped its path segment", u.Fragment)
	}
	if len(u.Query()) != 1 {
		t.Errorf("query = %v, want only the key parameter", u.Query())
	}
}

func TestResolveMapTilerKeyPrecedence(t *testing.T) {
	// Most specific instruction wins: what was typed on the command line, then
	// what the environment supplies, then what was saved for this user.
	tests := []struct {
		name     string
		flag     string
		env      string
		settings *Settings
		want     string
	}{
		{"flag beats everything", "from-flag", "from-env",
			&Settings{MapTilerKey: "from-settings"}, "from-flag"},
		{"env beats settings", "", "from-env",
			&Settings{MapTilerKey: "from-settings"}, "from-env"},
		{"settings are the last resort", "", "",
			&Settings{MapTilerKey: "from-settings"}, "from-settings"},
		{"nothing configured", "", "", &Settings{}, ""},
		{"nil settings", "", "", nil, ""},
		{"whitespace is not a value", "  ", "\t",
			&Settings{MapTilerKey: " from-settings "}, "from-settings"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(MapTilerKeyEnv, tc.env)

			if got := ResolveMapTilerKey(tc.flag, tc.settings); got != tc.want {
				t.Errorf("ResolveMapTilerKey = %q, want %q", got, tc.want)
			}
		})
	}
}

// A key saved by an earlier version, or written into the file by hand, has to
// survive the JSON round trip or the desktop build loses it on the next launch.
//
// Marshalling directly rather than through SaveSettings: that writes to the real
// per-user config directory on macOS and Windows, where there is no environment
// variable to redirect it, and a test has no business overwriting a developer's
// own settings.json.
func TestSettingsCarryMapTilerKey(t *testing.T) {
	data, err := json.Marshal(&Settings{MapTilerKey: "persisted-key"})
	if err != nil {
		t.Fatalf("marshalling settings: %v", err)
	}
	if !strings.Contains(string(data), `"maptiler_key"`) {
		t.Errorf("settings JSON %s has no maptiler_key field", data)
	}

	var got Settings
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshalling settings: %v", err)
	}
	if got.MapTilerKey != "persisted-key" {
		t.Errorf("MapTilerKey = %q after a round trip, want persisted-key", got.MapTilerKey)
	}

	// omitempty, so a settings file written before this field existed — and one
	// written by a user who never set a key — stays as it was.
	empty, err := json.Marshal(&Settings{})
	if err != nil {
		t.Fatalf("marshalling empty settings: %v", err)
	}
	if strings.Contains(string(empty), "maptiler_key") {
		t.Errorf("empty settings serialised as %s, want the field omitted", empty)
	}
}
