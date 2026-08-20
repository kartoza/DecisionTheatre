package config

import (
	"strings"
	"testing"
)

// The satellite basemap's provider has moved twice: Google's undocumented
// mt0.google.com raster endpoint (issue #65, outside the Google Maps terms of
// service), then Esri World Imagery, then MapTiler's Hybrid style — satellite
// imagery with roads and place labels composited in. This config is what
// makes each of those a deployment change rather than a code change.

func TestSatelliteDefaults(t *testing.T) {
	t.Setenv(MapTilerAPIKeyEnvVar, "test-key")
	var cfg Config

	url, attribution := cfg.Satellite()
	if url != DefaultSatelliteStyleURL() {
		t.Errorf("url = %q, want the default", url)
	}
	if attribution != DefaultSatelliteAttribution {
		t.Errorf("attribution = %q, want %q", attribution, DefaultSatelliteAttribution)
	}
}

func TestSatelliteHonoursConfiguration(t *testing.T) {
	cfg := Config{
		SatelliteStyleURL:    "https://example.test/style.json",
		SatelliteAttribution: "© Example",
	}

	url, attribution := cfg.Satellite()
	if url != "https://example.test/style.json" {
		t.Errorf("url = %q", url)
	}
	if attribution != "© Example" {
		t.Errorf("attribution = %q", attribution)
	}
}

// Crediting MapTiler for somebody else's style is worse than crediting
// nobody, so the default attribution applies only alongside the default URL.
func TestSatelliteDoesNotCreditTheDefaultProviderForAnotherURL(t *testing.T) {
	cfg := Config{SatelliteStyleURL: "https://example.test/style.json"}

	_, attribution := cfg.Satellite()
	if attribution == DefaultSatelliteAttribution {
		t.Errorf("attribution = %q for a non-default style URL", attribution)
	}
	if attribution != "" {
		t.Errorf("attribution = %q, want empty when none is configured", attribution)
	}
}

// An operator who sets only the attribution is describing the default imagery.
func TestSatelliteAttributionCanBeOverriddenAlone(t *testing.T) {
	t.Setenv(MapTilerAPIKeyEnvVar, "test-key")
	cfg := Config{SatelliteAttribution: "© Someone else entirely"}

	url, attribution := cfg.Satellite()
	if url != DefaultSatelliteStyleURL() {
		t.Errorf("url = %q, want the default", url)
	}
	if attribution != "© Someone else entirely" {
		t.Errorf("attribution = %q", attribution)
	}
}

// The two features sharing this key must never drift onto different ones.
func TestMapTilerAPIKeyIsEmbeddedInTheDefaultStyleURL(t *testing.T) {
	t.Setenv(MapTilerAPIKeyEnvVar, "test-key")
	if !strings.Contains(DefaultSatelliteStyleURL(), MapTilerAPIKey()) {
		t.Errorf("DefaultSatelliteStyleURL() = %q does not contain MapTilerAPIKey()", DefaultSatelliteStyleURL())
	}
}

// A deployment that forgets to set the key must not crash or leak a
// placeholder — it degrades to a style URL with an empty key. SatelliteAvailable
// is what stops that URL ever actually being fetched — see its own tests below.
func TestMapTilerAPIKeyEmptyWhenUnset(t *testing.T) {
	t.Setenv(MapTilerAPIKeyEnvVar, "")
	if got := MapTilerAPIKey(); got != "" {
		t.Errorf("MapTilerAPIKey() = %q, want empty", got)
	}
	if !strings.HasSuffix(DefaultSatelliteStyleURL(), "key=") {
		t.Errorf("DefaultSatelliteStyleURL() = %q, want it to end with an empty key= param", DefaultSatelliteStyleURL())
	}
}

// The default MapTiler style needs a key; a deployment with neither an
// operator-configured style URL nor a key has no usable satellite basemap at
// all, and should say so rather than let the client find out by a failed fetch.
func TestSatelliteUnavailableWithNoStyleURLOrKey(t *testing.T) {
	t.Setenv(MapTilerAPIKeyEnvVar, "")
	var cfg Config

	if cfg.SatelliteAvailable() {
		t.Error("SatelliteAvailable() = true with no style URL and no key configured")
	}
}

func TestSatelliteAvailableWithKeyConfigured(t *testing.T) {
	t.Setenv(MapTilerAPIKeyEnvVar, "test-key")
	var cfg Config

	if !cfg.SatelliteAvailable() {
		t.Error("SatelliteAvailable() = false with a key configured")
	}
}

// An operator-configured style URL is assumed usable on its own terms — it
// may not even be MapTiler, so the MapTiler key is irrelevant to it.
func TestSatelliteAvailableWithOperatorStyleURLEvenWithoutKey(t *testing.T) {
	t.Setenv(MapTilerAPIKeyEnvVar, "")
	cfg := Config{SatelliteStyleURL: "https://example.test/style.json"}

	if !cfg.SatelliteAvailable() {
		t.Error("SatelliteAvailable() = false for an operator-configured style URL")
	}
}
