package geodata_test

import (
	"context"
	"testing"

	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// newStore opens a GpkgStore over a synthetic datapack laid out around the
// origin: three catchments in a row at longitudes 0, 1 and 2.
func newStore(t *testing.T) *geodata.GpkgStore {
	t.Helper()

	dir := gpkgtest.Build(t, t.TempDir(), []gpkgtest.Catchment{
		{ID: 1000000001, Lat: 0, Long: 0, SizeDeg: 0.5, Current: gpkgtest.Float(10), Reference: gpkgtest.Float(1)},
		{ID: 1000000002, Lat: 0, Long: 1, SizeDeg: 0.5, Current: gpkgtest.Float(20), Reference: gpkgtest.Float(2)},
		// No current value: the real datapack has catchments with no data for
		// a given indicator, and the values query must leave them out rather
		// than shipping a zero that would paint as the domain minimum.
		{ID: 1000000003, Lat: 0, Long: 2, SizeDeg: 0.5, Current: nil, Reference: gpkgtest.Float(3)},
	}, 0, 100)

	store, err := geodata.NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

func TestQueryCatchmentValueArraysReturnsIDsAndValuesInBBox(t *testing.T) {
	store := newStore(t)

	// A bbox covering the first two catchments only.
	values, err := store.QueryCatchmentValueArrays(context.Background(), "current", gpkgtest.Attribute, -0.5, -0.5, 1.5, 0.5)
	if err != nil {
		t.Fatalf("QueryCatchmentValueArrays: %v", err)
	}

	if len(values.IDs) != len(values.Values) {
		t.Fatalf("ids and values must be index-aligned: %d ids, %d values", len(values.IDs), len(values.Values))
	}

	got := map[int64]float64{}
	for i, id := range values.IDs {
		got[id] = values.Values[i]
	}
	want := map[int64]float64{1000000001: 10, 1000000002: 20}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for id, v := range want {
		if got[id] != v {
			t.Errorf("catchment %d: got %v, want %v", id, got[id], v)
		}
	}
}

func TestQueryCatchmentValueArraysSkipsNullValues(t *testing.T) {
	store := newStore(t)

	values, err := store.QueryCatchmentValueArrays(context.Background(), "current", gpkgtest.Attribute, -5, -5, 5, 5)
	if err != nil {
		t.Fatalf("QueryCatchmentValueArrays: %v", err)
	}

	for _, id := range values.IDs {
		if id == 1000000003 {
			t.Fatalf("catchment with a NULL value was included; a missing value must stay missing "+
				"so the paint expression's coalesce decides how to render it (ids=%v)", values.IDs)
		}
	}
	if len(values.IDs) != 2 {
		t.Fatalf("expected the two valued catchments, got %v", values.IDs)
	}
}

// The values array and the GeoJSON feature collection are two shapes of one
// query. If they ever disagree about which catchments are in view, the
// vector-tile choropleth and the statistics panel would describe different data.
func TestQueryCatchmentValuesAgreesWithValueArrays(t *testing.T) {
	store := newStore(t)

	arrays, err := store.QueryCatchmentValueArrays(context.Background(), "reference", gpkgtest.Attribute, -5, -5, 5, 5)
	if err != nil {
		t.Fatalf("QueryCatchmentValueArrays: %v", err)
	}
	fc, err := store.QueryCatchmentValues(context.Background(), "reference", gpkgtest.Attribute, -5, -5, 5, 5)
	if err != nil {
		t.Fatalf("QueryCatchmentValues: %v", err)
	}

	if len(fc.Features) != len(arrays.IDs) {
		t.Fatalf("feature count %d != value count %d", len(fc.Features), len(arrays.IDs))
	}
	for i, f := range fc.Features {
		if f.ID != arrays.IDs[i] {
			t.Errorf("feature %d id %d != array id %d", i, f.ID, arrays.IDs[i])
		}
		if v, ok := f.Properties[gpkgtest.Attribute].(float64); !ok || v != arrays.Values[i] {
			t.Errorf("feature %d value %v != array value %v", i, f.Properties[gpkgtest.Attribute], arrays.Values[i])
		}
	}
}

func TestQueryCatchmentValueArraysRejectsUnknownAttribute(t *testing.T) {
	store := newStore(t)

	// The attribute name is interpolated into SQL, so an unvalidated one is an
	// injection point; the allow-list is loaded from scenario_current's columns.
	if _, err := store.QueryCatchmentValueArrays(context.Background(), "current", `x" FROM sqlite_master; --`, -5, -5, 5, 5); err == nil {
		t.Fatal("expected an error for an attribute that is not a known column")
	}
}
