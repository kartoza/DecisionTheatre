package datacheck

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

// ANSI styling. Every sequence is emitted through the style type below, which
// collapses to an empty string when the destination is not a terminal, so the
// same rendering code produces clean output when piped to a file or a CI log.
type style struct {
	enabled bool
}

func (s style) wrap(code, text string) string {
	if !s.enabled {
		return text
	}
	return "\033[" + code + "m" + text + "\033[0m"
}

func (s style) bold(t string) string   { return s.wrap("1", t) }
func (s style) dim(t string) string    { return s.wrap("2", t) }
func (s style) red(t string) string    { return s.wrap("0;31", t) }
func (s style) green(t string) string  { return s.wrap("0;32", t) }
func (s style) yellow(t string) string { return s.wrap("0;33", t) }
func (s style) blue(t string) string   { return s.wrap("0;36", t) }

// symbol returns the status glyph for a severity. Notes get a continuation
// mark rather than a status, because they elaborate on the line above.
func (s style) symbol(sev Severity) string {
	switch sev {
	case SeverityError:
		return s.red("✗")
	case SeverityWarn:
		return s.yellow("!")
	case SeverityNote:
		return s.dim("·")
	default:
		return s.green("✓")
	}
}

// errWriter accumulates the first write error so the render functions can be
// written as straight-line output and still report failure honestly, rather
// than checking every Fprintf or silently discarding the result.
type errWriter struct {
	w   io.Writer
	err error
}

func (e *errWriter) printf(format string, args ...any) {
	if e.err != nil {
		return
	}
	_, e.err = fmt.Fprintf(e.w, format, args...)
}

func (e *errWriter) println(s string) {
	if e.err != nil {
		return
	}
	_, e.err = fmt.Fprintln(e.w, s)
}

func (e *errWriter) nl() {
	if e.err != nil {
		return
	}
	_, e.err = fmt.Fprintln(e.w)
}

// isTerminal reports whether w is an interactive terminal.
func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// Render writes the human-readable report.
func (r *Report) Render(w io.Writer) error {
	s := style{enabled: isTerminal(w)}
	out := &errWriter{w: w}

	out.nl()
	out.println("  " + s.bold("Decision Theatre — Data Directory Report"))
	out.printf("  %s\n", s.dim(fmt.Sprintf("%s · %s · %d files",
		r.DataDir, humanSize(r.TotalSize), r.FileCount)))
	out.nl()

	// Column width for labels, so messages line up down the whole report.
	width := 0
	for _, sec := range r.Sections {
		for _, f := range sec.Findings {
			if n := len([]rune(f.Label)); n > width {
				width = n
			}
		}
	}
	if width > 34 {
		width = 34
	}

	for _, sec := range r.Sections {
		heading := s.blue(s.bold(strings.ToUpper(sec.Title)))
		subject := sec.Subject
		if sec.Size > 0 {
			subject += "  " + humanSize(sec.Size)
		}
		out.printf("  %s  %s\n", heading, s.dim(subject))

		if len(sec.Findings) == 0 {
			out.printf("    %s\n", s.dim("nothing to report"))
		}
		for _, f := range sec.Findings {
			label := f.Label
			if n := len([]rune(label)); n < width {
				label += strings.Repeat(" ", width-n)
			}
			out.printf("    %s %s  %s\n", s.symbol(f.Severity), label, f.Message)
			if f.Detail != "" {
				out.printf("      %s%s\n",
					strings.Repeat(" ", width), s.dim(f.Detail))
			}
		}
		out.nl()
	}

	// Inventory roll-up: what a pack would take, and what it would leave.
	r.renderInventory(out, s)

	errs, warns := r.Errors(), r.Warnings()
	var summary string
	switch {
	case errs > 0:
		summary = s.red(fmt.Sprintf("%d error%s", errs, plural(errs)))
	default:
		summary = s.green("no errors")
	}
	if warns > 0 {
		summary += s.dim(" · ") + s.yellow(fmt.Sprintf("%d warning%s", warns, plural(warns)))
	}
	out.printf("  %s\n", summary)

	if errs > 0 {
		out.printf("  %s\n", s.dim("the application will not work correctly against this directory"))
	}
	out.nl()
	return out.err
}

func (r *Report) renderInventory(out *errWriter, s style) {
	byRole := map[Role][]PathInfo{}
	for _, p := range r.Inventory {
		byRole[p.Role] = append(byRole[p.Role], p)
	}

	order := []Role{RoleRuntime, RoleBuildInput, RoleUserData, RoleExtraneous}
	labels := map[Role]string{
		RoleRuntime:    "READ BY THE APP",
		RoleBuildInput: "BUILD INPUTS",
		RoleUserData:   "USER DATA",
		RoleExtraneous: "EXTRANEOUS",
	}
	notes := map[Role]string{
		RoleRuntime:    "included in a data pack",
		RoleBuildInput: "inputs to 'make geopackage'; excluded from a data pack",
		RoleUserData:   "belongs to the installation; excluded from a data pack",
		RoleExtraneous: "nothing reads these; excluded from a data pack",
	}

	out.printf("  %s\n", s.blue(s.bold("INVENTORY")))
	for _, role := range order {
		items := byRole[role]
		if len(items) == 0 {
			continue
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Size > items[j].Size })

		var total int64
		for _, p := range items {
			total += p.Size
		}

		heading := labels[role]
		if role == RoleExtraneous {
			heading = s.yellow(heading)
		}
		out.printf("    %s  %s\n", heading,
			s.dim(fmt.Sprintf("%s · %s", humanSize(total), notes[role])))

		for _, p := range items {
			name := p.Path
			if p.IsDir {
				name += "/"
			}
			detail := humanSize(p.Size)
			if p.IsDir {
				detail = fmt.Sprintf("%s, %d files", detail, p.FileCount)
			}
			out.printf("      %-28s %s\n", name, s.dim(detail))
		}
		out.nl()
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// jsonFinding is the wire form of a finding.
type jsonFinding struct {
	Severity string `json:"severity"`
	Label    string `json:"label"`
	Message  string `json:"message"`
	Detail   string `json:"detail,omitempty"`
}

type jsonSection struct {
	Title    string        `json:"title"`
	Subject  string        `json:"subject"`
	Size     int64         `json:"size_bytes,omitempty"`
	Findings []jsonFinding `json:"findings"`
}

type jsonPath struct {
	Path      string `json:"path"`
	Role      string `json:"role"`
	Size      int64  `json:"size_bytes"`
	FileCount int    `json:"file_count"`
	IsDir     bool   `json:"is_dir"`
}

type jsonReport struct {
	DataDir   string        `json:"data_dir"`
	TotalSize int64         `json:"total_size_bytes"`
	FileCount int           `json:"file_count"`
	Errors    int           `json:"errors"`
	Warnings  int           `json:"warnings"`
	OK        bool          `json:"ok"`
	Sections  []jsonSection `json:"sections"`
	Inventory []jsonPath    `json:"inventory"`
}

// RenderJSON writes the report as JSON, for CI gates and other tooling that
// should not have to parse the human-readable form.
func (r *Report) RenderJSON(w io.Writer) error {
	out := jsonReport{
		DataDir:   r.DataDir,
		TotalSize: r.TotalSize,
		FileCount: r.FileCount,
		Errors:    r.Errors(),
		Warnings:  r.Warnings(),
		OK:        r.OK(),
	}

	for _, sec := range r.Sections {
		js := jsonSection{Title: sec.Title, Subject: sec.Subject, Size: sec.Size}
		for _, f := range sec.Findings {
			js.Findings = append(js.Findings, jsonFinding{
				Severity: f.Severity.String(),
				Label:    strings.TrimSpace(f.Label),
				Message:  f.Message,
				Detail:   f.Detail,
			})
		}
		out.Sections = append(out.Sections, js)
	}

	for _, p := range r.Inventory {
		out.Inventory = append(out.Inventory, jsonPath{
			Path:      p.Path,
			Role:      p.Role.String(),
			Size:      p.Size,
			FileCount: p.FileCount,
			IsDir:     p.IsDir,
		})
	}

	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
