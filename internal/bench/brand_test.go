package bench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// paletteSourceOfTruth is docs/assets/css/kartoza-palette.json, relative to this
// package. The documentation CSS and the generated diagrams read the same file.
const paletteSourceOfTruth = "../../docs/assets/css/kartoza-palette.json"

// The comment on Brand promises this test exists. It did not, which meant the
// copy of the palette in brand.go could drift from the source of truth with
// nothing to catch it — and a report in the wrong blue is a report that does not
// look like it came from Kartoza. A copy that can drift is a copy that will.
func TestBrandMatchesSourceOfTruth(t *testing.T) {
	fromFile, err := BrandFromFile(paletteSourceOfTruth)
	if err != nil {
		t.Fatalf("read the palette source of truth: %v", err)
	}

	if got, want := DefaultBrand(), fromFile; !reflect.DeepEqual(got, want) {
		gv, wv := reflect.ValueOf(got), reflect.ValueOf(want)
		for i := 0; i < gv.NumField(); i++ {
			if gv.Field(i).String() != wv.Field(i).String() {
				t.Errorf("Brand.%s = %q in brand.go but %q in %s",
					gv.Type().Field(i).Name, gv.Field(i).String(), wv.Field(i).String(),
					filepath.Base(paletteSourceOfTruth))
			}
		}
	}
}

// Every colour the report draws with must actually be set. Guards against a new
// field being added to Brand and left empty, which renders as a CSS variable
// with no value and a report that silently loses a colour.
func TestEveryBrandFieldIsPopulated(t *testing.T) {
	b := reflect.ValueOf(DefaultBrand())

	for i := 0; i < b.NumField(); i++ {
		if strings.TrimSpace(b.Field(i).String()) == "" {
			t.Errorf("Brand.%s is empty", b.Type().Field(i).Name)
		}
	}
}

// A palette file missing a key must say which key, not return a Brand with a
// blank colour in it. Guards against a silently half-branded report.
func TestAPaletteMissingAKeyNamesTheKeyRatherThanReturningABlankColour(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "palette.json")

	full, err := os.ReadFile(paletteSourceOfTruth)
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]any
	if err := json.Unmarshal(full, &p); err != nil {
		t.Fatal(err)
	}
	delete(p["ink"].(map[string]any), "muted")

	trimmed, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, trimmed, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := BrandFromFile(path)
	if err == nil {
		t.Fatal("a palette with a missing key loaded without complaint")
	}
	if !strings.Contains(err.Error(), "ink.muted") {
		t.Errorf("error = %q, want it to name ink.muted", err)
	}
	if got != (Brand{}) {
		t.Errorf("a failed load returned a partly filled Brand: %+v", got)
	}
}

// An unreadable or unparseable palette must be an explained error rather than an
// unbranded report nobody notices.
func TestAnUnreadablePaletteIsAnExplainedError(t *testing.T) {
	dir := t.TempDir()

	if _, err := BrandFromFile(filepath.Join(dir, "absent.json")); err == nil ||
		!strings.Contains(err.Error(), "read palette") {
		t.Errorf("missing palette error = %v, want it to say the file could not be read", err)
	}

	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := BrandFromFile(bad); err == nil || !strings.Contains(err.Error(), "parse palette") {
		t.Errorf("unparseable palette error = %v, want it to say the file could not be parsed", err)
	}
}

// The report's colours and typefaces must reach the markup, since the whole
// point of carrying a copy of the palette is that the artefact looks like
// Kartoza's.
//
// This test found a bug. html/template's CSS value filter rejects any
// interpolated value containing a quote and substitutes the sentinel ZgotmplZ.
// The font stacks contain quotes — 'Helvetica Neue' — so both --sans and --mono
// rendered as ZgotmplZ and every report and PDF came out in the browser's
// default serif with the sentinel visible in its stylesheet. Fixed by typing the
// two fields as template.CSS; see the comment on Brand.
func TestTheBrandReachesTheRenderedReport(t *testing.T) {
	b := DefaultBrand()
	html := renderFor(t, Compare(runOf(measured("a", 1)), runOf(measured("a", 1))), ReportOptions{})

	for _, want := range []string{b.Blue500, b.Amber500, b.InkDefault, b.SurfaceCloud, b.Error} {
		if !strings.Contains(html, want) {
			t.Errorf("brand colour %s did not reach the report", want)
		}
	}
	for _, want := range []string{string(b.FontSans), string(b.FontMono)} {
		if !strings.Contains(html, want) {
			t.Errorf("font stack %q did not reach the report", want)
		}
	}
	if strings.Contains(html, "ZgotmplZ") {
		t.Error("the report contains html/template's ZgotmplZ sentinel: a value was rejected by an " +
			"escaper and the stylesheet is broken where it appears")
	}
}

// A caller-supplied brand must override the default, so a report can be produced
// in another palette without editing the package.
func TestASuppliedBrandOverridesTheDefault(t *testing.T) {
	custom := DefaultBrand()
	custom.Blue500 = "#010203"

	html := renderFor(t, Compare(runOf(measured("a", 1)), runOf(measured("a", 1))),
		ReportOptions{Brand: &custom})

	if !strings.Contains(html, "#010203") {
		t.Error("the supplied brand did not reach the report")
	}
}
