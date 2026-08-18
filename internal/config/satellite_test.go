package config

import "testing"

// The satellite tile template was hardcoded twice in the frontend, and pointed at
// Google's undocumented mt0.google.com endpoint — which needs no key, which is
// exactly why using it falls outside the Google Maps terms of service. Replacing
// the provider is a separate live decision (issue #65); this config is what makes
// it a deployment change rather than a code change.

func TestSatelliteDefaults(t *testing.T) {
	var cfg Config

	url, attribution := cfg.Satellite()
	if url != DefaultSatelliteTileURL {
		t.Errorf("url = %q, want the default", url)
	}
	if attribution != DefaultSatelliteAttribution {
		t.Errorf("attribution = %q, want %q", attribution, DefaultSatelliteAttribution)
	}
}

func TestSatelliteHonoursConfiguration(t *testing.T) {
	cfg := Config{
		SatelliteTileURL:     "https://example.test/{z}/{x}/{y}.jpg",
		SatelliteAttribution: "© Example",
	}

	url, attribution := cfg.Satellite()
	if url != "https://example.test/{z}/{x}/{y}.jpg" {
		t.Errorf("url = %q", url)
	}
	if attribution != "© Example" {
		t.Errorf("attribution = %q", attribution)
	}
}

// Crediting Google for somebody else's imagery is worse than crediting nobody, so
// the default attribution applies only alongside the default URL.
func TestSatelliteDoesNotCreditTheDefaultProviderForAnotherURL(t *testing.T) {
	cfg := Config{SatelliteTileURL: "https://example.test/{z}/{x}/{y}.jpg"}

	_, attribution := cfg.Satellite()
	if attribution == DefaultSatelliteAttribution {
		t.Errorf("attribution = %q for a non-default tile URL", attribution)
	}
	if attribution != "" {
		t.Errorf("attribution = %q, want empty when none is configured", attribution)
	}
}

// An operator who sets only the attribution is describing the default imagery.
func TestSatelliteAttributionCanBeOverriddenAlone(t *testing.T) {
	cfg := Config{SatelliteAttribution: "© Someone else entirely"}

	url, attribution := cfg.Satellite()
	if url != DefaultSatelliteTileURL {
		t.Errorf("url = %q, want the default", url)
	}
	if attribution != "© Someone else entirely" {
		t.Errorf("attribution = %q", attribution)
	}
}
