package geodata

import (
	"encoding/json"
	"math"
	"testing"

	polyclip "github.com/ctessum/polyclip-go"
)

// polyclipPolygonToGeoJSON returned a hardcoded 0 as its area, and
// DissolveCatchments passed that straight to the API — so the "area" field in
// every dissolve response has been 0 since the function was written.

// box returns a rectangular contour in lon/lat degrees.
func box(minLon, minLat, maxLon, maxLat float64) polyclip.Contour {
	return polyclip.Contour{
		{X: minLon, Y: minLat},
		{X: maxLon, Y: minLat},
		{X: maxLon, Y: maxLat},
		{X: minLon, Y: maxLat},
	}
}

// closeTo reports whether got is within tolerance (a fraction) of want.
func closeTo(got, want, tolerance float64) bool {
	if want == 0 {
		return math.Abs(got) < tolerance
	}
	return math.Abs(got-want)/math.Abs(want) <= tolerance
}

// A degree of latitude is about 110.57 km and a degree of longitude about
// 111.32 km at the equator, so a 1°×1° box there is roughly 12,300 km².
func TestSphericalRingAreaAtTheEquator(t *testing.T) {
	ring := [][2]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}, {0, 0}}

	got := sphericalRingAreaKm2(ring)

	const want = 12308.0
	if !closeTo(got, want, 0.01) {
		t.Errorf("area = %.1f km², want about %.0f", got, want)
	}
}

// The same box of degrees covers far less ground at high latitude — the error the
// existing 111-km-per-degree helper makes, and the reason this uses a spherical
// formula.
func TestSphericalRingAreaShrinksWithLatitude(t *testing.T) {
	equator := sphericalRingAreaKm2([][2]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}, {0, 0}})
	south := sphericalRingAreaKm2([][2]float64{{0, -35}, {1, -35}, {1, -34}, {0, -34}, {0, -35}})

	if south >= equator {
		t.Errorf("a degree box at 35°S measured %.0f km², not less than %.0f at the equator",
			south, equator)
	}
	// cos(34.5°) ≈ 0.824, so expect roughly that fraction.
	if ratio := south / equator; !closeTo(ratio, 0.824, 0.02) {
		t.Errorf("ratio to the equatorial box = %.3f, want about 0.824", ratio)
	}
}

// Winding must not change the magnitude: the ring order coming out of polyclip is
// not guaranteed.
func TestSphericalRingAreaIsSignIndependent(t *testing.T) {
	clockwise := [][2]float64{{0, 0}, {0, 1}, {1, 1}, {1, 0}, {0, 0}}
	counter := [][2]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}, {0, 0}}

	if a, b := sphericalRingAreaKm2(clockwise), sphericalRingAreaKm2(counter); !closeTo(a, b, 1e-9) {
		t.Errorf("winding changed the area: %.3f against %.3f", a, b)
	}
}

func TestSphericalRingAreaOfADegenerateRing(t *testing.T) {
	for name, ring := range map[string][][2]float64{
		"empty":      {},
		"two points": {{0, 0}, {1, 1}},
		"a line":     {{0, 0}, {1, 0}, {0, 0}},
	} {
		if got := sphericalRingAreaKm2(ring); got != 0 {
			t.Errorf("%s: area = %v, want 0", name, got)
		}
	}
}

// The end-to-end fix: a dissolved polygon reports a real area.
func TestDissolvedPolygonReportsItsArea(t *testing.T) {
	poly := polyclip.Polygon{box(0, 0, 1, 1)}

	geometry, area, err := polyclipPolygonToGeoJSON(poly)
	if err != nil {
		t.Fatalf("polyclipPolygonToGeoJSON: %v", err)
	}
	if len(geometry) == 0 {
		t.Fatal("no geometry returned")
	}

	if area == 0 {
		t.Fatal("area is 0 — the hardcoded zero is still being returned")
	}
	if !closeTo(area, 12308.0, 0.01) {
		t.Errorf("area = %.1f km², want about 12308", area)
	}
}

// Two separate boxes: the areas add.
func TestDisjointPolygonsSumTheirAreas(t *testing.T) {
	poly := polyclip.Polygon{box(0, 0, 1, 1), box(10, 0, 11, 1)}

	_, area, err := polyclipPolygonToGeoJSON(poly)
	if err != nil {
		t.Fatalf("polyclipPolygonToGeoJSON: %v", err)
	}

	single := sphericalRingAreaKm2([][2]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}, {0, 0}})
	if !closeTo(area, 2*single, 0.01) {
		t.Errorf("area = %.1f km², want about %.1f for two boxes", area, 2*single)
	}
}

// A hole must be excluded, not counted twice.
func TestHoleIsSubtractedFromTheArea(t *testing.T) {
	outer := box(0, 0, 2, 2)
	hole := box(0.5, 0.5, 1.5, 1.5)

	solid, solidArea, err := polyclipPolygonToGeoJSON(polyclip.Polygon{outer})
	if err != nil {
		t.Fatalf("solid: %v", err)
	}
	withHole, holedArea, err := polyclipPolygonToGeoJSON(polyclip.Polygon{outer, hole})
	if err != nil {
		t.Fatalf("with a hole: %v", err)
	}

	if holedArea >= solidArea {
		t.Fatalf("the holed polygon measured %.1f km², not less than the solid %.1f",
			holedArea, solidArea)
	}

	// The hole is a 1°×1° box centred on 1°N, so subtracting it should account for
	// the whole difference.
	holeArea := sphericalRingAreaKm2([][2]float64{
		{0.5, 0.5}, {1.5, 0.5}, {1.5, 1.5}, {0.5, 1.5}, {0.5, 0.5},
	})
	if !closeTo(solidArea-holedArea, holeArea, 0.01) {
		t.Errorf("the hole removed %.1f km², want %.1f", solidArea-holedArea, holeArea)
	}

	// And the geometry really does carry the hole, or the area would be right by
	// accident while the shape was wrong.
	var parsed struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(withHole, &parsed); err != nil {
		t.Fatalf("parsing the geometry: %v", err)
	}
	if parsed.Type != "Polygon" {
		t.Errorf("type = %q, want Polygon", parsed.Type)
	}
	var rings [][][2]float64
	if err := json.Unmarshal(parsed.Coordinates, &rings); err != nil {
		t.Fatalf("parsing the rings: %v", err)
	}
	if len(rings) != 2 {
		t.Errorf("got %d rings, want an outer and a hole", len(rings))
	}

	if len(solid) == 0 {
		t.Error("the solid polygon produced no geometry")
	}
}
