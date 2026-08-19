package bench

import (
	"encoding/json"
	"fmt"
	"html/template"
	"os"
)

// Brand carries the palette and typography the report is drawn with.
//
// docs/assets/css/kartoza-palette.json is the single source of truth for these —
// it already feeds the documentation CSS and the generated diagrams, and its own
// comment says so. The values below are a copy, because a command-line tool must
// produce a report from a directory that may not contain the documentation, and
// reading a file that might not be there is a worse failure than carrying a copy.
//
// A copy that can drift is a copy that will. TestBrandMatchesSourceOfTruth reads
// the JSON and fails if these fall out of step, which is the same discipline the
// flake hashes and the walkthrough manifest are held to.
type Brand struct {
	BlueBrand string
	Blue100   string
	Blue300   string
	Blue500   string
	Blue700   string
	Blue900   string

	AmberBrand string
	Amber100   string
	Amber300   string
	Amber500   string
	Amber700   string
	Amber900   string

	GreyBrand string

	InkDefault string
	InkMuted   string
	InkRule    string

	SurfaceCloud string
	SurfaceWhite string

	Success     string
	SuccessTint string
	Warn        string
	WarnTint    string
	Error       string
	ErrorTint   string

	// The font stacks are template.CSS rather than string because they contain
	// the quotes a CSS font-family needs — 'Helvetica Neue' — and html/template's
	// CSS value filter rejects any interpolated value containing a quote,
	// substituting the sentinel ZgotmplZ. As plain strings the report's --sans
	// and --mono custom properties both rendered as "ZgotmplZ", so every report
	// and every PDF came out in the browser's default serif with the sentinel
	// visible in its stylesheet. TestTheBrandReachesTheRenderedReport covers it.
	//
	// The values are safe to mark as CSS: DefaultBrand's are compile-time
	// constants and BrandFromFile reads a repository asset, the same trust level
	// as the SVG brand mark. A caller pointing BrandFromFile at an untrusted file
	// would be injecting CSS, which is the same caveat that already applies to
	// ReportOptions.MarkPath.
	FontSans template.CSS
	FontMono template.CSS
}

// DefaultBrand is the palette as it stands in the source of truth.
func DefaultBrand() Brand {
	return Brand{
		BlueBrand: "#54a2cc",
		Blue100:   "#e4f1f8",
		Blue300:   "#9ccae2",
		Blue500:   "#54a2cc",
		Blue700:   "#2f7ba5",
		Blue900:   "#1b526f",

		AmberBrand: "#eeb348",
		Amber100:   "#fcf3e0",
		Amber300:   "#f5d18f",
		Amber500:   "#eeb348",
		Amber700:   "#c68f2b",
		Amber900:   "#8a611a",

		GreyBrand: "#8a8b8b",

		InkDefault: "#383939",
		InkMuted:   "#676869",
		InkRule:    "#d1d1d1",

		SurfaceCloud: "#f5f5f2",
		SurfaceWhite: "#ffffff",

		Success:     "#3c7d54",
		SuccessTint: "#eaf3ec",
		Warn:        "#eeb348",
		WarnTint:    "#fcf3e0",
		Error:       "#b0473c",
		ErrorTint:   "#fbefef",

		FontSans: "Nunito, 'Helvetica Neue', Arial, sans-serif",
		FontMono: "'JetBrains Mono', monospace",
	}
}

// paletteFile mirrors the parts of the source-of-truth JSON this package uses.
type paletteFile struct {
	Brand map[string]string `json:"brand"`
	Blue  map[string]string `json:"blue"`
	Amber map[string]string `json:"amber"`
	Ink   map[string]string `json:"ink"`

	Surface map[string]string `json:"surface"`
	Status  map[string]string `json:"status"`
	Font    map[string]string `json:"font"`
}

// BrandFromFile reads the source of truth. Used by the drift test, and available
// to a caller that would rather read the real file than trust the copy.
func BrandFromFile(path string) (Brand, error) {
	var b Brand

	data, err := os.ReadFile(path)
	if err != nil {
		return b, fmt.Errorf("read palette: %w", err)
	}
	var p paletteFile
	if err := json.Unmarshal(data, &p); err != nil {
		return b, fmt.Errorf("parse palette: %w", err)
	}

	get := func(m map[string]string, key, what string) string {
		v, ok := m[key]
		if !ok {
			err = fmt.Errorf("palette is missing %s.%s", what, key)
		}
		return v
	}

	b = Brand{
		BlueBrand:  get(p.Brand, "blue", "brand"),
		AmberBrand: get(p.Brand, "amber", "brand"),
		GreyBrand:  get(p.Brand, "grey", "brand"),

		Blue100: get(p.Blue, "100", "blue"),
		Blue300: get(p.Blue, "300", "blue"),
		Blue500: get(p.Blue, "500", "blue"),
		Blue700: get(p.Blue, "700", "blue"),
		Blue900: get(p.Blue, "900", "blue"),

		Amber100: get(p.Amber, "100", "amber"),
		Amber300: get(p.Amber, "300", "amber"),
		Amber500: get(p.Amber, "500", "amber"),
		Amber700: get(p.Amber, "700", "amber"),
		Amber900: get(p.Amber, "900", "amber"),

		InkDefault: get(p.Ink, "default", "ink"),
		InkMuted:   get(p.Ink, "muted", "ink"),
		InkRule:    get(p.Ink, "rule", "ink"),

		SurfaceCloud: get(p.Surface, "cloud", "surface"),
		SurfaceWhite: get(p.Surface, "white", "surface"),

		Success:     get(p.Status, "success", "status"),
		SuccessTint: get(p.Status, "successTint", "status"),
		Warn:        get(p.Status, "warn", "status"),
		WarnTint:    get(p.Status, "warnTint", "status"),
		Error:       get(p.Status, "error", "status"),
		ErrorTint:   get(p.Status, "errorTint", "status"),

		FontSans: template.CSS(get(p.Font, "sans", "font")),
		FontMono: template.CSS(get(p.Font, "mono", "font")),
	}
	if err != nil {
		return Brand{}, err
	}
	return b, nil
}
