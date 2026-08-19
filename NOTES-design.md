# dtbench report — visual design notes

Territory: `internal/bench/report.html.tmpl`, plus two typeface files added
beside it. Nothing else was edited. Everything that needed a number or a field I
do not own is in [What I need from other
people](#what-i-need-from-other-people) rather than reached for.

## Artefacts to compare

| File | What it is |
|---|---|
| `01-before-with-fonts-installed.pdf` | The original template, printed on a machine that happens to have Nunito. This is the best the report ever looked. |
| `02-before-on-a-fontless-host.pdf` | The same template, same data, printed on a host with no usable fontconfig. Two pages, every rule and bar and block of colour present, **not one glyph**. This is what CI produced. |
| `03-after-commit-a.pdf` | The redesign, against the current field set. |
| `04-after-commit-a-stress-case.pdf` | The same, on a synthesised comparison with broken, added and removed scenarios and two comparability warnings. |
| `05-after-commit-b-with-ux-fields.pdf` | The redesign using `Findings`, `Method`, `NotRun` and `CaveatLong` from `bench/ux`. |

All in `…/scratchpad/design-pdfs/`. Every "after" was printed on a host with
**no fonts at all** — the worst case, not the best one.

---

## The blocking fault: the report had no text

Two causes, stacked, and neither is visible in a browser on a developer's
machine.

**One.** The palette's font stacks reach the template through `html/template`'s
CSS sanitiser. It cannot prove a value containing quotes and commas is safe, so
it replaced both declarations with its sentinel:

```css
--sans:ZgotmplZ; --mono:ZgotmplZ;
```

Every report ever produced by this template was set in the browser's default
face, and every "monospace" figure column in a proportional one. Grep any
generated report for `ZgotmplZ`. (QA has since typed the two `Brand` fields as
`template.CSS`, which fixes the interpolation — see the asks below for why the
template still does not use them directly.)

**Two.** "The browser's default face" is nothing at all on a build container.
With `font-family` naming a family that does not exist, Chromium falls back to
its default, and where fontconfig knows one family or none, that default
resolves to nothing: it printed the layout and dropped every glyph.

### Both faces are now embedded, and the stack order is load-bearing

This is the part worth reading before touching the CSS. Measured on a host with
an empty font set:

| `--sans` | Result |
|---|---|
| `"Report Sans", "Nunito", Helvetica, Arial, sans-serif` | renders |
| `"Nunito", "Helvetica Neue", Helvetica, Arial, "Report Sans", sans-serif` | **blank** |
| `"Nunito", "Helvetica Neue", Arial, "Report Sans"` | **blank** |

Chromium resolves the first family, finds nothing, and abandons the fallback
chain before it reaches the `@font-face` rule. The embedded alias has to come
first. Do not "tidy" the palette's families back to the front of those stacks;
the comment in the template says so too.

The report now prints identically with the brand fonts installed, with only
DejaVu Sans present, and with fontconfig absent entirely.

---

## Everything else that was wrong

**The cover broke the brand rules it was meant to express.** The rules are
written at the top of `docs/assets/css/custom.css`: flat, no gradients; charcoal
carries body text and the header; blue and amber are never body text. The cover
was a three-stop blue gradient with a rotated white sheen over it, and at its
pale end it ran white type onto blue 500 — **2.83:1**, under AA. It is now the
charcoal masthead and amber keyline the documentation uses.

**The mark floated.** `kartoza-symbol-color.svg` carries `width="500"
height="500"`. The CSS set only the height, leaving a 500px-wide box with the
artwork centred in it, which is why the symbol sat adrift in the middle of the
cover instead of at its left margin.

**Amber text failed contrast everywhere it appeared.** Amber 700 measures
**2.85:1** on white and was carrying the caveats, the "new"/"removed" verdicts
and the warning card. Amber 900 (5.52:1) carries them now. The full matrix I
measured:

| on white | ratio | |
|---|---|---|
| amber 700 `#c68f2b` | 2.85 | fails |
| amber 900 `#8a611a` | 5.52 | passes |
| success `#3c7d54` | 4.94 | passes on **white**, 4.36 on its own tint — fails |
| error `#b0473c` | 5.51 | passes |
| muted ink `#676869` | 5.58 | passes |
| brand grey `#8a8b8b` | 3.42 | non-text only |
| white on blue 500 | 2.83 | fails |
| white on blue 700 | 4.67 | passes |

The rule I applied: tinted panels carry **ink**, never their own status colour;
status colours are for keylines, drawn shapes, and numerals set large enough to
qualify as large text.

**Six tables, six different grids.** Each group got its own `<table>`, and
`table-layout: auto` sized each independently, so no figure ever landed under
the figure above it. It is one table now, `table-layout: fixed`, with the
column widths declared once in a `<colgroup>`.

**Rows split across page breaks, and headings orphaned.** One `<tbody>` per
scenario with `break-inside: avoid` keeps a scenario's figures and its caveat
together. The group label rides *inside* its first scenario's `<tbody>` rather
than in one of its own, which makes an orphaned group heading structurally
impossible rather than merely unlikely. `<thead>` reprints the column labels on
every page.

**Two selectors were doing damage invisibly.**

- `.caveat` matched the `<tr>` as well as the `<span>` inside it. `display:
  block` on a `<tr>` stops it being a table row: the cell dropped out of the
  fixed grid and rendered at the width of column one, setting a two-line caveat
  one word to a line down two hundred points of page.
- `.rail div` matched the nested `.k` and `.v` divs, so every label and every
  value drew its own 4mm padding and its own hairline rule. That was the
  mysterious 13mm gap between each label and its value.

Both are scoped now. They are the same mistake twice and worth watching for.

**The duration bar was painted by verdict.** A *faster* scenario's bar was
green — but the bar's length reports duration, not goodness, so a full-width
green bar was saying "this is the slowest thing here" while looking like praise.
It is blue now, always. Verdict colour lives on the record's spine.

**The credit line printed a tofu box.** 💗 has no glyph without an emoji font.
It is drawn as an inline SVG heart in amber 500. A missing glyph in the one line
carrying the Kartoza name is worse than a substituted shape.

**Prose everywhere.** Each row carried two or three lines explaining what the
scenario is evidence about, which tripled the height of the table and buried the
figures it was there to explain. Same text, moved to an appendix set two-up at
reference size.

---

## What the reader sees now

Page one is the answer and nothing else, and it is always the same shape:

1. Anything that undermines the comparison — broken scenarios, scenarios that
   did not run, comparability warnings — printed **above** the result, so the
   tally cannot be read in isolation.
2. `Findings` cards: what actually moved, with the tone on the keyline and the
   numeral.
3. The verdict tally, demoted to a 7mm strip. It answers "did anything get
   slower" and stops there, because counting verdicts is not the finding —
   `0 faster · 0 slower · 7 unchanged` over a run whose payload fell 5.7 MB to
   1.7 MB is true and is the opposite of the story.
4. The lede, one sentence.

The evidence starts on its own page. The cost is that a short comparison pays
for a page break it may not need; the benefit is that page one never changes
shape with the number of warnings.

Colour is never the only carrier of meaning: every verdict has a drawn shape as
well as a colour, and the tally's segments are named in a legend.

---

## Brand judgement calls

**The embedded face is Source Sans 3, not Nunito.** The palette says Nunito and
I would rather have shipped Nunito. nixpkgs ships it as OpenType only, and this
dev shell has no subsetting tool, so three static weights would have cost about
a megabyte of base64 per report and still left no italic. Source Sans 3 is
already vendored in this repository, refreshed from nixpkgs by `dt
vendor-fonts`, OFL-1.1 like Nunito, variable — 166 KB spans weights 200–900, so
headings get a drawn extra-bold rather than a synthesised one — and it is the
face the Decision Theatre application already sets its own headings in, so the
report matches the product it measures. JetBrains Mono is the palette's own and
is embedded as specified (111 KB, variable).

Both are aliased as **"Report Sans"** and **"Report Mono"** rather than by their
real names, deliberately: the aliases mean "whichever face this report embeds",
so vendoring Nunito later changes one payload and no stack.

**Cost:** about 320 KB of base64, so a report is ~410 KB of HTML. The PDF
subsets and stays around 400 KB. That is the price of an artefact that renders
on a machine you do not control, and it is worth paying.

**Amber, not red, for an accepted cost.** The `warn` tone renders amber. A
deliberate trade that costs +820% is not a regression, and painting it red would
be dishonest in the other direction — the failure mode nobody checks for. A zero
change renders neutral for the same reason.

**No zebra striping on the table**, although the documentation's tables have it.
Records here are two and three rows tall, so striping bands unevenly. The
verdict spine and a hairline per record do the same job more quietly.

**Amber h2 rules, charcoal headings**, matching `.md-typeset h2`. The original
used blue headings on a blue rule, which introduced a third accent doing a job
amber already does across the estate.

---

## What I need from other people

### 1. The bar scale is wrong and I cannot fix it in CSS

`BarWidth` is `current p50 ÷ the widest median in the report`. With one scenario
at 4.3 s and thirteen under a millisecond, twelve of them compute to 0.6% or
less, clamp to 1, and are indistinguishable. `health` at 0.09 ms and
`catchments-bounds` at 28 ms — a 300× difference — draw the same mark.

I have made the honest best of it: the column is labelled "vs. slowest", the
scale is stated as linear, and anything under 3% draws as a square tick so it
reads as "negligible against the slowest" rather than as a broken chart. That
one full bar makes a true and useful point: one request is the entire time
budget.

It still cannot compare two fast scenarios. There is no arithmetic in Go
templates, so the fix has to be in `report.go`. Either:

- **`BarWidth` scaled per group** — cheapest, and makes the Metadata and Tiles
  groups readable against themselves; or
- **a log scale**, `BarWidth = log(p50/floor) / log(max/floor) × 100`, with a
  `BarScaleNote` string the template can print. An unlabelled log axis is a lie
  in chart form, so the note is not optional.

Per-group is my preference. Both are a handful of lines where `widest` is
computed today.

### 2. Per-scenario payload chart — the fields it needs

The paired before/after bars sorted by payload are the right chart and I cannot
draw them: `BytesLabel` is a formatted string, and normalising bar lengths
across rows needs a maximum that only Go can see. Four fields on `reportDelta`:

```go
BytesBeforeWidth int    // 0–100, scaled to the largest *baseline* payload in the report
BytesAfterWidth  int    // 0–100, same scale, so the pair is comparable
BytesBeforeLabel string // "5.5 MB"  — HumanBytes, already exists
BytesAfterLabel  string // "1.1 MB"
BytesChangeLabel string // "−93%" — U+2212, and the sign must read as a reduction
BytesTone        string // good | bad | flat | warn, same vocabulary as reportFinding.Tone
```

Two traps the coordinator already hit and I would hit again: a reduction must
read `−93%`, not `+93%`; and a scenario that is already compressed on the wire
scoring 0% is the correct answer, so its tone is `flat`, not `bad`.

Ordering: deltas sorted by baseline payload descending, either as a separate
slice (`ByPayload []reportDelta`) or as the group order. A separate slice is
cleaner — the chart wants the whole suite in one sequence, not grouped.

The CSS is ready for it and follows the shape that survived Tim's review of the
draft:

```css
.paired { display: grid; grid-template-columns: 42mm minmax(0, 1fr) 18mm; gap: 1.5mm 3mm; }
.paired .bars { min-width: 0; }          /* or a long bar shoves the delta column out of line */
.paired .bar { height: 2.4mm; background: var(--blue-300); }
.paired .bar.after { background: var(--blue-700); }
.paired .delta { text-align: right; font-variant-numeric: var(--figures); }
.paired .delta.good { color: var(--success); }
.paired .delta.bad  { color: var(--error); }
.paired .delta.warn { color: var(--amber-900); }
.paired .delta.flat { color: var(--muted); }   /* an em dash, not a red zero */
```

Note `.flat` uses `--muted`, not `--rule`. `--rule` (#d1d1d1) is 1.6:1 on white
— fine for a hairline, invisible as a character.

### 3. Font stacks: hold the interpolation

QA typed `Brand.FontSans` and `Brand.FontMono` as `template.CSS`, which is the
right fix and I have not undone it. But the template still writes its stacks out
literally, because of the ordering finding above: the embedded alias has to come
first or nothing renders. Once QA's change merges, the correct end state is

```css
--sans: "Report Sans", {{ .Brand.FontSans }};
--mono: "Report Mono", {{ .Brand.FontMono }};
```

which is a two-line change I have deliberately not made, because on this branch
alone it would render `ZgotmplZ` again.

### 4. The blobs should come from `go:embed`, not from the template

`internal/bench/report-sans.woff2` and `report-mono.woff2` are in the package
and are the documented source of the two base64 payloads (their sha256s are in
the template's comment). The base64 is pasted into the template only because
`report.go` is not mine this week. The tidy version is one field:

```go
// FontFaceCSS is the @font-face block, with both typefaces base64'd from the
// woff2 files embedded beside this file.
FontFaceCSS template.CSS
```

and the template's second `<style>` block becomes `{{ .FontFaceCSS }}`. That
drops ~320 KB of base64 out of the source tree and makes drift impossible.

Two housekeeping items that go with it: `report-mono.woff2` came from the
nixpkgs `jetbrains-mono` package by hand, so `scripts/vendor-fonts.sh` should
gain `jetbrains-mono:JetBrainsMono[wght].woff2` and a destination in
`internal/bench/`; and `frontend/src/assets/fonts/README.md` already flags that
`LICENSES/OFL-1.1.txt` is missing for REUSE, which now applies to two more files.

### 5. A test that would have caught the blank report

`WritePDF` checks only that the file exists, which is why a wordless PDF was
reported as success three separate times. The check that matters is that the
PDF contains extractable text — and, better, that it contains a string only the
report produces, such as the title. Not my file, but it is the single most
valuable test in this package.

### 6. The masthead subtitle duplicates the rail

`cmd/dtbench` builds `defaultSubtitle` as `"%s compared with %s"` from
`base.Describe()` and `cur.Describe()` — which is exactly what the provenance
rail already prints under **Baseline** and **Compared with**, verbatim, three
centimetres lower. The template cannot tell a default subtitle from one the user
typed, so it prints both. Either make the default empty, or make it a one-line
summary that is not the same two strings.

### 7. Small things

- `Caveat` is now rendered as a chip beside the scenario name, so it needs to
  stay to a few words; `CaveatLong` is an endnote. If `Caveat` grows to a
  sentence the chip will wrap badly.
- `VerdictClass` values I style by name: `faster`, `slower`, `unchanged`,
  `broken`, `added`, `removed`, `unmeasurable`. Anything else falls back to a
  neutral grey dash, which looks deliberate but says nothing — tell me the name
  and I will draw it.
- `Iterations`, `Warmup` and `NoiseFloorPercent` are no longer used by the
  template; `Method` supersedes them. They can go if nothing else wants them.

---

## Sequencing

`a1caebd` is the redesign against the **current** field set and is
self-contained: it builds, runs, and prints a correct report on its own.

The commit after it adopts `Findings`, `Method`, `NotRun`, `NotRunNames` and
`CaveatLong`, and **requires `internal/bench/report.go` from `bench/ux`**.
Without it, `dtbench report` fails cleanly with
`can't evaluate field NotRun in type bench.reportData`. It was verified by
rendering the template against a mirror of the `bench/ux` struct shape rather
than by editing anyone else's worktree. Merge the two together, or take the ux
branch first.
