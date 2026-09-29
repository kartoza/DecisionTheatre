#!/usr/bin/env python3
"""A small PDF writer, and the charts the benchmark report draws with it.

Standard library only, like the rest of dtbench. That is the whole reason this
file exists rather than an import of reportlab: the benchmark's most useful
property is that it can be copied onto a server and run there, and that stops
being true the moment it needs something installed. PDF is a text format with a
byte-offset table at the end, and the subset needed for tables and line charts
is genuinely small.

It uses the base-14 fonts (Helvetica, Helvetica-Bold, Courier), which every
reader has and none of which need embedding. That is the other half of staying
dependency-free — a font file would have to come from somewhere.

WHAT IT DELIBERATELY DOES NOT DO

No compression, no encryption, no images, no transparency, no Unicode. Text is
WinAnsi, and anything outside it is transliterated rather than silently dropped,
because a report that quietly loses a character is worse than one that renders
an approximation of it. Files come out at tens of kilobytes, which for a
document nobody archives is not worth a zlib dependency-free reimplementation.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# --------------------------------------------------------------------------
# Font metrics
#
# Widths per 1000 units of em, from the base-14 AFMs. Without these, anything
# centred or right-aligned is centred or right-aligned by guess, and a column
# of numbers stops lining up — which in a table of measurements is not a
# cosmetic problem, because a misaligned column is a misread column.
# --------------------------------------------------------------------------

_HELV = {
    " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667,
    "'": 191, "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333,
    ".": 278, "/": 278, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584,
    "?": 556, "@": 1015, "[": 278, "\\": 278, "]": 278, "^": 469, "_": 556,
    "`": 333, "{": 334, "|": 260, "}": 334, "~": 584,
    "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778,
    "H": 722, "I": 278, "J": 500, "K": 667, "L": 556, "M": 833, "N": 722,
    "O": 778, "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722,
    "V": 667, "W": 944, "X": 667, "Y": 667, "Z": 611,
    "a": 556, "b": 556, "c": 500, "d": 556, "e": 556, "f": 278, "g": 556,
    "h": 556, "i": 222, "j": 222, "k": 500, "l": 222, "m": 833, "n": 556,
    "o": 556, "p": 556, "q": 556, "r": 333, "s": 500, "t": 278, "u": 556,
    "v": 500, "w": 722, "x": 500, "y": 500, "z": 500,
}
for _d in "0123456789":
    _HELV[_d] = 556

_HELV_BOLD = dict(_HELV)
_HELV_BOLD.update({
    "A": 722, "B": 722, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778,
    "J": 556, "K": 722, "L": 611, "P": 667, "S": 667,
    "a": 556, "b": 611, "c": 556, "d": 611, "e": 556, "f": 333, "g": 611,
    "h": 611, "i": 278, "j": 278, "k": 556, "l": 278, "m": 889, "n": 611,
    "o": 611, "p": 611, "q": 611, "r": 389, "s": 556, "t": 333, "u": 611,
    "v": 556, "w": 778, "x": 556, "y": 556, "z": 500,
    "&": 722, "'": 238, '"': 474, "!": 333, "?": 611, ":": 333, ";": 333,
    "@": 975, "^": 584, "`": 333, "{": 389, "|": 280, "}": 389,
})

HELVETICA = "F1"
HELVETICA_BOLD = "F2"
COURIER = "F3"

_METRICS = {HELVETICA: _HELV, HELVETICA_BOLD: _HELV_BOLD}


def text_width(s: str, size: float, font: str = HELVETICA) -> float:
    """Width of a string in points."""
    if font == COURIER:
        return len(s) * size * 0.6
    table = _METRICS.get(font, _HELV)
    return sum(table.get(c, 556) for c in s) * size / 1000.0


# Characters this project's own comments and labels actually produce, mapped to
# something WinAnsi can render. An em dash arriving as a blank would quietly
# change the meaning of a sentence.
_TRANSLIT = {
    "—": "-", "–": "-", "‘": "'", "’": "'",
    "“": '"', "”": '"', "…": "...", "×": "x",
    "→": "->", "≥": ">=", "≤": "<=", "µ": "u",
    "•": "-", " ": " ",
}


def _escape(s: str) -> bytes:
    """Encode for a PDF string literal.

    Backslash, and both parentheses, end or corrupt the literal if passed
    through. A label containing a bracket is not exotic — "p95 (ms)" is one —
    so getting this wrong produces a file that opens to a blank page.
    """
    out = []
    for ch in s:
        ch = _TRANSLIT.get(ch, ch)
        for c in ch:
            if c in "()\\":
                out.append("\\" + c)
            elif ord(c) < 32:
                out.append(" ")
            elif ord(c) < 127:
                out.append(c)
            else:
                try:
                    out.append("\\%03o" % ord(c.encode("cp1252")))
                except (UnicodeEncodeError, TypeError):
                    out.append("?")
    return "".join(out).encode("latin-1", "replace")


# --------------------------------------------------------------------------
# Colours
# --------------------------------------------------------------------------

BLACK = (0.0, 0.0, 0.0)
INK = (0.13, 0.13, 0.15)
MUTED = (0.45, 0.45, 0.48)
FAINT = (0.85, 0.85, 0.87)
PAPER = (1.0, 1.0, 1.0)
BAND = (0.96, 0.96, 0.97)
# Green for faster, red for slower. Both are darkened past the point where they
# are pleasant, because a percentage in pale red on white is unreadable when
# printed, and this document is meant to be printable.
GOOD = (0.11, 0.47, 0.24)
BAD = (0.70, 0.14, 0.14)
WARN = (0.72, 0.45, 0.05)
ACCENT = (0.11, 0.32, 0.55)


# --------------------------------------------------------------------------
# Document
# --------------------------------------------------------------------------

A4 = (595.28, 841.89)


@dataclass
class Page:
    width: float
    height: float
    ops: list[bytes] = field(default_factory=list)


class PDF:
    """A document built top-down.

    Coordinates are given from the top-left corner, because that is how a page
    is laid out in the head and PDF's bottom-left origin is a source of
    off-by-a-page-height mistakes with no compensating benefit. The flip
    happens here, once.
    """

    def __init__(self, size: tuple[float, float] = A4) -> None:
        self.width, self.height = size
        self.pages: list[Page] = []
        self._page: Page | None = None

    # -- page management ---------------------------------------------------

    def add_page(self) -> None:
        self._page = Page(self.width, self.height)
        self.pages.append(self._page)

    @property
    def page(self) -> Page:
        if self._page is None:
            self.add_page()
        assert self._page is not None
        return self._page

    def _y(self, y: float) -> float:
        return self.height - y

    # -- drawing -----------------------------------------------------------

    def text(self, x: float, y: float, s: str, size: float = 9.0,
             font: str = HELVETICA, color: tuple = INK,
             align: str = "left") -> None:
        if not s:
            return
        if align == "right":
            x -= text_width(s, size, font)
        elif align == "center":
            x -= text_width(s, size, font) / 2.0
        r, g, b = color
        self.page.ops.append(
            b"BT /%s %.2f Tf %.3f %.3f %.3f rg %.2f %.2f Td (" %
            (font.encode(), size, r, g, b, x, self._y(y) - size * 0.8)
            + _escape(s) + b") Tj ET")

    def line(self, x1: float, y1: float, x2: float, y2: float,
             width: float = 0.5, color: tuple = FAINT) -> None:
        r, g, b = color
        self.page.ops.append(
            b"%.3f %.3f %.3f RG %.2f w %.2f %.2f m %.2f %.2f l S" %
            (r, g, b, width, x1, self._y(y1), x2, self._y(y2)))

    def rect(self, x: float, y: float, w: float, h: float,
             fill: tuple | None = None, stroke: tuple | None = None,
             width: float = 0.5) -> None:
        if fill is None and stroke is None:
            return
        parts = []
        if fill:
            parts.append(b"%.3f %.3f %.3f rg" % fill)
        if stroke:
            parts.append(b"%.3f %.3f %.3f RG %.2f w" % (*stroke, width))
        parts.append(b"%.2f %.2f %.2f %.2f re" % (x, self._y(y + h), w, h))
        parts.append(b"B" if (fill and stroke) else (b"f" if fill else b"S"))
        self.page.ops.append(b" ".join(parts))

    def polyline(self, points: list[tuple[float, float]], width: float = 1.2,
                 color: tuple = ACCENT) -> None:
        if len(points) < 2:
            return
        r, g, b = color
        ops = [b"%.3f %.3f %.3f RG %.2f w %.2f %.2f m" %
               (r, g, b, width, points[0][0], self._y(points[0][1]))]
        for x, y in points[1:]:
            ops.append(b"%.2f %.2f l" % (x, self._y(y)))
        ops.append(b"S")
        self.page.ops.append(b" ".join(ops))

    def dot(self, x: float, y: float, radius: float = 2.0,
            color: tuple = ACCENT) -> None:
        """A filled circle, approximated with four Bezier arcs."""
        k = radius * 0.5523
        cy = self._y(y)
        r, g, b = color
        self.page.ops.append(
            b"%.3f %.3f %.3f rg %.2f %.2f m "
            b"%.2f %.2f %.2f %.2f %.2f %.2f c "
            b"%.2f %.2f %.2f %.2f %.2f %.2f c "
            b"%.2f %.2f %.2f %.2f %.2f %.2f c "
            b"%.2f %.2f %.2f %.2f %.2f %.2f c f" % (
                r, g, b, x + radius, cy,
                x + radius, cy + k, x + k, cy + radius, x, cy + radius,
                x - k, cy + radius, x - radius, cy + k, x - radius, cy,
                x - radius, cy - k, x - k, cy - radius, x, cy - radius,
                x + k, cy - radius, x + radius, cy - k, x + radius, cy))

    # -- output ------------------------------------------------------------

    def save(self, path) -> None:
        objects: list[bytes] = []

        def add(body: bytes) -> int:
            objects.append(body)
            return len(objects)

        font_ids = {
            HELVETICA: add(b"<< /Type /Font /Subtype /Type1 /BaseFont "
                           b"/Helvetica /Encoding /WinAnsiEncoding >>"),
            HELVETICA_BOLD: add(b"<< /Type /Font /Subtype /Type1 /BaseFont "
                                b"/Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
            COURIER: add(b"<< /Type /Font /Subtype /Type1 /BaseFont "
                         b"/Courier /Encoding /WinAnsiEncoding >>"),
        }
        resources = b"<< /Font << " + b" ".join(
            b"/%s %d 0 R" % (n.encode(), i) for n, i in font_ids.items()
        ) + b" >> >>"

        # The page tree object has to be numbered before the pages that name it
        # as parent, so its slot is claimed now and filled in at the end.
        pages_id = add(b"")

        page_ids = []
        for pg in self.pages:
            stream = b"\n".join(pg.ops)
            content_id = add(b"<< /Length %d >>\nstream\n" % len(stream)
                             + stream + b"\nendstream")
            page_ids.append(add(
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %.2f %.2f] "
                b"/Resources %s /Contents %d 0 R >>" %
                (pages_id, pg.width, pg.height, resources, content_id)))

        objects[pages_id - 1] = (
            b"<< /Type /Pages /Kids [" +
            b" ".join(b"%d 0 R" % i for i in page_ids) +
            b"] /Count %d >>" % len(page_ids))
        catalog_id = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)

        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for i, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % i + body + b"\nendobj\n"

        xref_at = len(out)
        out += b"xref\n0 %d\n" % (len(objects) + 1)
        out += b"0000000000 65535 f \n"
        for off in offsets[1:]:
            out += b"%010d 00000 n \n" % off
        out += (b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n"
                % (len(objects) + 1, catalog_id, xref_at))

        with open(path, "wb") as f:
            f.write(bytes(out))


# --------------------------------------------------------------------------
# Charts
# --------------------------------------------------------------------------

def nice_ceiling(value: float) -> float:
    """Round up to something a person would choose for an axis top.

    An axis labelled 4873.2 is arithmetically honest and useless to read
    against. This gives 5000.
    """
    if value <= 0:
        return 1.0
    import math
    magnitude = 10 ** math.floor(math.log10(value))
    for step in (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if value <= step * magnitude:
            return step * magnitude
    return 10 * magnitude


def line_chart(pdf: PDF, x: float, y: float, w: float, h: float,
               series: list[float], labels: list[str], title: str,
               unit: str = "ms", highlight_last: bool = True,
               markers: list[tuple | None] | None = None) -> None:
    """One measurement over the history of runs.

    The y axis starts at zero on purpose. A chart auto-scaled to its own data
    turns a 3% wobble into a mountain range, which is how a benchmark report
    ends up arguing for work that does not need doing. If the change is real it
    is visible against zero.
    """
    pdf.text(x, y, title, size=9.5, font=HELVETICA_BOLD, color=INK)
    top = y + 14
    plot_h = h - 28
    plot_w = w - 46

    if not series:
        pdf.text(x, top + plot_h / 2, "no data", size=8, color=MUTED)
        return

    ceiling = nice_ceiling(max(series))
    left = x + 42

    # Horizontal gridlines, labelled. Four bands is enough to read a value off
    # and few enough not to become the loudest thing on the page.
    for i in range(5):
        gy = top + plot_h * (1 - i / 4.0)
        pdf.line(left, gy, left + plot_w, gy, width=0.4,
                 color=FAINT if i else MUTED)
        pdf.text(left - 5, gy - 2.5, _fmt_axis(ceiling * i / 4.0), size=6.5,
                 color=MUTED, align="right")

    pdf.text(x, top - 3, unit, size=6.5, color=MUTED)

    step = plot_w / max(len(series) - 1, 1)
    pts = [(left + i * step, top + plot_h * (1 - v / ceiling))
           for i, v in enumerate(series)]
    pdf.polyline(pts, width=1.3, color=ACCENT)

    for i, (px, py) in enumerate(pts):
        colour = ACCENT
        if markers and i < len(markers) and markers[i]:
            colour = markers[i]
        last = highlight_last and i == len(pts) - 1
        pdf.dot(px, py, radius=2.6 if last else 1.8, color=colour)

    # X labels thin out rather than overlapping into illegibility.
    every = max(1, len(labels) // 8)
    for i, lab in enumerate(labels):
        if i % every and i != len(labels) - 1:
            continue
        pdf.text(left + i * step, top + plot_h + 9, lab, size=6,
                 color=MUTED, align="center")


def _fmt_axis(v: float) -> str:
    if v == 0:
        return "0"
    if v >= 1000:
        return f"{v / 1000:.1f}k".replace(".0k", "k")
    if v >= 10:
        return f"{v:.0f}"
    if v >= 1:
        return f"{v:.1f}"
    return f"{v:.2f}"
