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
	var cfg Config

	url, attribution := cfg.Satellite()
	if url != DefaultSatelliteStyleURL {
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
	cfg := Config{SatelliteAttribution: "© Someone else entirely"}

	url, attribution := cfg.Satellite()
	if url != DefaultSatelliteStyleURL {
		t.Errorf("url = %q, want the default", url)
	}
	if attribution != "© Someone else entirely" {
		t.Errorf("attribution = %q", attribution)
	}
}

// The two features sharing this key must never drift onto different ones.
func TestMapTilerAPIKeyIsEmbeddedInTheDefaultStyleURL(t *testing.T) {
	if !strings.Contains(DefaultSatelliteStyleURL, MapTilerAPIKey) {
		t.Errorf("DefaultSatelliteStyleURL = %q does not contain MapTilerAPIKey", DefaultSatelliteStyleURL)
	}
}
