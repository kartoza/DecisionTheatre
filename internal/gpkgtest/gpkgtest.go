// Package gpkgtest builds a minimal, in-memory-sized datapack geopackage on
// disk so that the geodata and api packages can be tested against the real
// SQLite queries rather than a hand-rolled fake.
//
// The real datapack is several gigabytes and is not present in a checkout, so
// before this existed the only thing the tests could assert about a query was
// what happened when the store was nil. Everything here is deliberately the
// smallest schema those queries actually touch: get it wrong and the test fails
// with a SQL error naming the missing table, which is itself the signal that a
// query has grown a new dependency.
package gpkgtest

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// Catchment is one row of the synthetic datapack: a square polygon of side
// SizeDeg centred on (Lat, Long), with one attribute value per scenario.
type Catchment struct {
	ID        int64
	Lat, Long float64
	SizeDeg   float64
	// Current and Reference are the attribute values for the two scenario
	// tables. A nil pointer writes SQL NULL, which is how the real datapack
	// represents a catchment with no data for an indicator.
	Current, Reference *float64
}

// Attribute is the single indicator column the synthetic datapack carries. The
// queries under test build SQL by interpolating the attribute name, so the tests
// need a name to pass in; one column is enough to exercise that.
const Attribute = "rainfall_mm"

// Build writes a datapack.gpkg into dir containing the given catchments and
// returns the path to the directory (which is what NewGpkgStore takes).
//
// domainMin/domainMax populate the domain_minima/domain_maxima tables that
// GetDomainRange reads.
func Build(t *testing.T, dir string, catchments []Catchment, domainMin, domainMax float64) string {
	t.Helper()

	path := filepath.Join(dir, "datapack.gpkg")
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatalf("open synthetic geopackage: %v", err)
	}
	defer db.Close()

	stmts := []string{
		// The geojson column is what both the detailed render path and the
		// grid geometry cache read; the lat/long/SUB_AREA columns are what the
		// aggregation path bins and weights by.
		`CREATE TABLE catchments_lev12 (
			fid INTEGER PRIMARY KEY,
			HYBAS_ID TEXT,
			HYBAS_ID_int INTEGER,
			lat REAL, long REAL, SUB_AREA REAL,
			geojson TEXT
		)`,
		// Not a real rtree virtual table: every query only ever SELECTs
		// id/minx/maxx/miny/maxy from it, so a plain table with those columns
		// exercises the same join without depending on the rtree module being
		// compiled into the driver.
		`CREATE TABLE rtree_catchments_lev12_geom (
			id INTEGER, minx REAL, maxx REAL, miny REAL, maxy REAL
		)`,
		fmt.Sprintf(`CREATE TABLE scenario_current (catchment_id_int INTEGER, "%s" REAL)`, Attribute),
		fmt.Sprintf(`CREATE TABLE scenario_reference (catchment_id_int INTEGER, "%s" REAL)`, Attribute),
		fmt.Sprintf(`CREATE TABLE domain_minima ("%s" REAL)`, Attribute),
		fmt.Sprintf(`CREATE TABLE domain_maxima ("%s" REAL)`, Attribute),
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("create synthetic schema: %v\n%s", err, s)
		}
	}

	for i, c := range catchments {
		half := c.SizeDeg / 2
		minx, maxx := c.Long-half, c.Long+half
		miny, maxy := c.Lat-half, c.Lat+half
		geojson := fmt.Sprintf(
			`{"type":"Polygon","coordinates":[[[%f,%f],[%f,%f],[%f,%f],[%f,%f],[%f,%f]]]}`,
			minx, miny, maxx, miny, maxx, maxy, minx, maxy, minx, miny)

		fid := int64(i + 1)
		if _, err := db.Exec(
			`INSERT INTO catchments_lev12 (fid, HYBAS_ID, HYBAS_ID_int, lat, long, SUB_AREA, geojson)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			fid, fmt.Sprintf("%d", c.ID), c.ID, c.Lat, c.Long, c.SizeDeg*c.SizeDeg, geojson,
		); err != nil {
			t.Fatalf("insert catchment: %v", err)
		}
		if _, err := db.Exec(
			`INSERT INTO rtree_catchments_lev12_geom (id, minx, maxx, miny, maxy) VALUES (?, ?, ?, ?, ?)`,
			fid, minx, maxx, miny, maxy,
		); err != nil {
			t.Fatalf("insert rtree row: %v", err)
		}
		for table, value := range map[string]*float64{
			"scenario_current":   c.Current,
			"scenario_reference": c.Reference,
		} {
			if _, err := db.Exec(
				fmt.Sprintf(`INSERT INTO %s (catchment_id_int, "%s") VALUES (?, ?)`, table, Attribute),
				c.ID, value,
			); err != nil {
				t.Fatalf("insert %s row: %v", table, err)
			}
		}
	}

	if _, err := db.Exec(
		fmt.Sprintf(`INSERT INTO domain_minima ("%s") VALUES (?)`, Attribute), domainMin,
	); err != nil {
		t.Fatalf("insert domain minimum: %v", err)
	}
	if _, err := db.Exec(
		fmt.Sprintf(`INSERT INTO domain_maxima ("%s") VALUES (?)`, Attribute), domainMax,
	); err != nil {
		t.Fatalf("insert domain maximum: %v", err)
	}

	return dir
}

// Float returns a pointer to v, for populating Catchment's nullable values.
func Float(v float64) *float64 { return &v }
