package geodata

import "testing"

// TestBasinLevelForZoomMatchesTilesetZoomBands pins basinLevelForZoom's zoom
// bands to the ones scripts/gpkg_to_mbtiles.sh tiles the same basins at (see
// datasources/mbtiles-config/layer-treatment.csv). If the mbtiles zoom bands
// change, this test is the reminder to change this function to match, so the
// choropleth and the basemap outlines never disagree about which level is
// "current" at a given zoom.
func TestBasinLevelForZoomMatchesTilesetZoomBands(t *testing.T) {
	cases := []struct {
		zoom      float64
		wantLevel string
		wantOK    bool
	}{
		{2, "04", true},
		{5.9, "04", true},
		{6, "06", true},
		{8.9, "06", true},
		{9, "08", true},
		{10.9, "08", true},
		{11, "", false},
		{15, "", false},
	}
	for _, c := range cases {
		level, ok := basinLevelForZoom(c.zoom)
		if level != c.wantLevel || ok != c.wantOK {
			t.Errorf("basinLevelForZoom(%v) = (%q, %v), want (%q, %v)", c.zoom, level, ok, c.wantLevel, c.wantOK)
		}
	}
}
