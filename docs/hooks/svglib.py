"""Minimal dependency-free SVG builder for Kartoza-branded documentation diagrams.

Deliberately not a general graphics library. It provides just enough — rounded
boxes, lanes, arrows, labels, legends — to draw the architecture and state
diagrams in this documentation, using colours loaded from
``docs/assets/css/kartoza-palette.json`` so that generated illustrations and the
site's own chrome cannot drift apart.

Everything is plain string construction: no runtime dependency beyond the Python
standard library, which keeps the docs build reproducible under Nix.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from xml.sax.saxutils import escape

# Nunito is a fairly round humanist sans; 0.56em average advance is a close
# enough approximation for laying out short labels without measuring glyphs.
_CHAR_W = 0.56
_MONO_CHAR_W = 0.60


def load_palette(docs_dir: Path) -> dict:
    """Load the shared brand palette, falling back to built-in defaults."""
    path = Path(docs_dir) / "assets" / "css" / "kartoza-palette.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {
            "brand": {"blue": "#54a2cc", "amber": "#eeb348", "grey": "#8a8b8b"},
            "blue": {"100": "#e4f1f8", "300": "#9ccae2", "500": "#54a2cc",
                     "700": "#2f7ba5", "900": "#1b526f"},
            "amber": {"100": "#fcf3e0", "300": "#f5d18f", "500": "#eeb348",
                      "700": "#c68f2b", "900": "#8a611a"},
            "ink": {"default": "#383939", "muted": "#676869", "rule": "#d1d1d1"},
            "surface": {"cloud": "#f5f5f2", "white": "#ffffff"},
            "status": {"success": "#3c7d54", "successTint": "#eaf3ec",
                       "warn": "#eeb348", "warnTint": "#fcf3e0",
                       "error": "#b0473c", "errorTint": "#fbefef"},
            "font": {"sans": "Nunito, 'Helvetica Neue', Arial, sans-serif",
                     "mono": "'JetBrains Mono', monospace"},
        }


def text_width(s: str, size: float, mono: bool = False) -> float:
    return len(s) * size * (_MONO_CHAR_W if mono else _CHAR_W)


@dataclass
class Box:
    """A rounded node with a title and optional detail lines."""

    x: float
    y: float
    w: float
    h: float
    title: str
    lines: list[str] = field(default_factory=list)
    fill: str = "#ffffff"
    stroke: str = "#54a2cc"
    text: str = "#383939"
    mono: bool = False
    dashed: bool = False

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def bottom(self) -> float:
        return self.y + self.h


class Diagram:
    """Accumulates SVG fragments and renders a complete, self-contained document."""

    def __init__(self, width: float, height: float, palette: dict,
                 title: str = "", subtitle: str = ""):
        self.w = width
        self.h = height
        self.p = palette
        self.title = title
        self.subtitle = subtitle
        self.parts: list[str] = []
        self._font = palette["font"]["sans"]
        self._mono = palette["font"]["mono"]

    # -- primitives ---------------------------------------------------------

    def box(self, b: Box) -> Box:
        dash = ' stroke-dasharray="5 4"' if b.dashed else ""
        self.parts.append(
            f'<rect x="{b.x:.1f}" y="{b.y:.1f}" width="{b.w:.1f}" height="{b.h:.1f}" '
            f'rx="7" fill="{b.fill}" stroke="{b.stroke}" stroke-width="1.6"{dash}/>'
        )
        font = self._mono if b.mono else self._font
        if b.lines:
            ty = b.y + 21
            self.parts.append(
                f'<text x="{b.cx:.1f}" y="{ty:.1f}" text-anchor="middle" '
                f'font-family="{font}" font-size="13" font-weight="700" '
                f'fill="{b.text}">{escape(b.title)}</text>'
            )
            for i, line in enumerate(b.lines):
                self.parts.append(
                    f'<text x="{b.cx:.1f}" y="{ty + 16 + i * 14:.1f}" text-anchor="middle" '
                    f'font-family="{self._mono}" font-size="11" '
                    f'fill="{self.p["ink"]["muted"]}">{escape(line)}</text>'
                )
        else:
            self.parts.append(
                f'<text x="{b.cx:.1f}" y="{b.cy + 4.5:.1f}" text-anchor="middle" '
                f'font-family="{font}" font-size="13" font-weight="600" '
                f'fill="{b.text}">{escape(b.title)}</text>'
            )
        return b

    def lane(self, x: float, y: float, w: float, h: float, label: str,
             fill: str | None = None, stroke: str | None = None) -> None:
        fill = fill or self.p["surface"]["cloud"]
        stroke = stroke or self.p["ink"]["rule"]
        self.parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="10" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>'
        )
        self.parts.append(
            f'<text x="{x + 14:.1f}" y="{y + 20:.1f}" font-family="{self._font}" '
            f'font-size="12" font-weight="700" letter-spacing="0.06em" '
            f'fill="{self.p["ink"]["muted"]}">{escape(label.upper())}</text>'
        )

    def arrow(self, x1: float, y1: float, x2: float, y2: float,
              color: str | None = None, label: str = "",
              dashed: bool = False, curve: float = 0.0) -> None:
        color = color or self.p["brand"]["grey"]
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        if curve:
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2 - curve
            d = f"M {x1:.1f} {y1:.1f} Q {mx:.1f} {my:.1f} {x2:.1f} {y2:.1f}"
            self.parts.append(
                f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.6"'
                f'{dash} marker-end="url(#arrow)"/>'
            )
            lx, ly = mx, my + 2
        else:
            self.parts.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
                f'stroke="{color}" stroke-width="1.6"{dash} marker-end="url(#arrow)"/>'
            )
            lx, ly = (x1 + x2) / 2, (y1 + y2) / 2 - 6
        if label:
            self.parts.append(
                f'<text x="{lx:.1f}" y="{ly:.1f}" text-anchor="middle" '
                f'font-family="{self._font}" font-size="10.5" '
                f'fill="{self.p["ink"]["muted"]}">{escape(label)}</text>'
            )

    def label(self, x: float, y: float, s: str, size: float = 12,
              anchor: str = "start", color: str | None = None,
              weight: str = "400", mono: bool = False) -> None:
        color = color or self.p["ink"]["default"]
        font = self._mono if mono else self._font
        self.parts.append(
            f'<text x="{x:.1f}" y="{y:.1f}" text-anchor="{anchor}" '
            f'font-family="{font}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}">{escape(s)}</text>'
        )

    def pill(self, x: float, y: float, s: str, fill: str, text: str = "#ffffff",
             size: float = 10.5) -> float:
        w = text_width(s, size) + 16
        self.parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="18" rx="9" fill="{fill}"/>'
        )
        self.parts.append(
            f'<text x="{x + w / 2:.1f}" y="{y + 12.5:.1f}" text-anchor="middle" '
            f'font-family="{self._font}" font-size="{size}" font-weight="700" '
            f'fill="{text}">{escape(s)}</text>'
        )
        return w

    def legend(self, x: float, y: float, entries: list[tuple[str, str]]) -> None:
        cx = x
        for colour, text in entries:
            self.parts.append(
                f'<rect x="{cx:.1f}" y="{y - 8:.1f}" width="11" height="11" rx="2.5" '
                f'fill="{colour}" stroke="{self.p["ink"]["rule"]}" stroke-width="0.8"/>'
            )
            self.label(cx + 17, y + 1, text, size=11, color=self.p["ink"]["muted"])
            cx += 17 + text_width(text, 11) + 22

    def step(self, x: float, y: float, w: float, h: float, n: int, title: str,
             lines: list[str] | None = None, accent: str | None = None) -> Box:
        """A numbered flow step: circled ordinal, title, optional detail lines."""
        accent = accent or self.p["blue"]["500"]
        b = Box(x, y, w, h, title, fill=self.p["surface"]["white"], stroke=accent)
        self.parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="8" '
            f'fill="{self.p["surface"]["white"]}" stroke="{accent}" stroke-width="1.6"/>'
        )
        self.parts.append(
            f'<circle cx="{x + 24:.1f}" cy="{y + 24:.1f}" r="13" fill="{accent}"/>'
            f'<text x="{x + 24:.1f}" y="{y + 28.5:.1f}" text-anchor="middle" '
            f'font-family="{self._font}" font-size="13" font-weight="800" '
            f'fill="#ffffff">{n}</text>'
        )
        self.label(x + 46, y + 24, title, size=13, weight="700")
        for i, line in enumerate(lines or []):
            self.label(x + 46, y + 44 + i * 14, line, size=11,
                       color=self.p["ink"]["muted"])
        return b

    def bar(self, x: float, y: float, w: float, frac: float, colour: str,
            label: str, value: str = "", h: float = 16) -> None:
        """A labelled proportional bar, for counts and coverage."""
        frac = max(0.0, min(1.0, frac))
        self.label(x, y + h - 4, label, size=11.5)
        bx = x + 190
        bw = w - 190
        self.parts.append(
            f'<rect x="{bx:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{h:.1f}" rx="{h/2:.1f}" '
            f'fill="{self.p["surface"]["cloud"]}" stroke="{self.p["ink"]["rule"]}" stroke-width="0.8"/>'
        )
        if frac > 0:
            self.parts.append(
                f'<rect x="{bx:.1f}" y="{y:.1f}" width="{max(bw * frac, h):.1f}" height="{h:.1f}" '
                f'rx="{h/2:.1f}" fill="{colour}"/>'
            )
        if value:
            self.label(bx + bw + 10, y + h - 4, value, size=11, weight="700",
                       color=self.p["ink"]["muted"])

    def stack(self, x: float, y: float, w: float, layers: list[tuple[str, str]],
              lh: float = 40) -> None:
        """A vertical layered stack, topmost first. layers = [(label, colour)]."""
        for i, (text, colour) in enumerate(layers):
            ly = y + i * (lh + 4)
            self.parts.append(
                f'<rect x="{x:.1f}" y="{ly:.1f}" width="{w:.1f}" height="{lh:.1f}" rx="6" '
                f'fill="{colour}" stroke="{self.p["ink"]["rule"]}" stroke-width="1"/>'
            )
            self.label(x + w / 2, ly + lh / 2 + 4.5, text, size=12.5,
                       anchor="middle", weight="700")

    def matrix(self, x: float, y: float, cols: list[str], rows: list[str],
               cells: dict[tuple[int, int], tuple[str, str]],
               cw: float = 120, ch: float = 38, label_w: float = 150) -> None:
        """A grid. cells maps (row, col) -> (text, fill)."""
        for c, name in enumerate(cols):
            self.label(x + label_w + c * cw + cw / 2, y - 8, name, size=11.5,
                       anchor="middle", weight="700", color=self.p["ink"]["muted"])
        for r, name in enumerate(rows):
            ry = y + r * ch
            self.label(x + label_w - 12, ry + ch / 2 + 4, name, size=11.5, anchor="end")
            for c in range(len(cols)):
                text, fill = cells.get((r, c), ("", self.p["surface"]["white"]))
                cx = x + label_w + c * cw
                self.parts.append(
                    f'<rect x="{cx:.1f}" y="{ry:.1f}" width="{cw - 6:.1f}" height="{ch - 6:.1f}" '
                    f'rx="5" fill="{fill}" stroke="{self.p["ink"]["rule"]}" stroke-width="0.9"/>'
                )
                if text:
                    self.label(cx + (cw - 6) / 2, ry + (ch - 6) / 2 + 4, text, size=11,
                               anchor="middle", weight="700")

    def panes(self, x: float, y: float, w: float, h: float, cols: int, rows: int,
              labels: list[str] | None = None, gap: float = 6) -> None:
        """A grid of viewport panes, for layout illustrations."""
        pw = (w - gap * (cols - 1)) / cols
        ph = (h - gap * (rows - 1)) / rows
        i = 0
        for r in range(rows):
            for c in range(cols):
                px = x + c * (pw + gap)
                py = y + r * (ph + gap)
                self.parts.append(
                    f'<rect x="{px:.1f}" y="{py:.1f}" width="{pw:.1f}" height="{ph:.1f}" rx="5" '
                    f'fill="{self.p["blue"]["100"]}" stroke="{self.p["blue"]["500"]}" stroke-width="1.2"/>'
                )
                if labels and i < len(labels):
                    self.label(px + pw / 2, py + ph / 2 + 4, labels[i], size=11,
                               anchor="middle", weight="700", color=self.p["blue"]["900"])
                i += 1

    def swipe(self, x: float, y: float, w: float, h: float,
              left: str, right: str) -> None:
        """Two-scenario swipe comparison illustration."""
        half = w / 2
        self.parts.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{half:.1f}" height="{h:.1f}" rx="6" '
            f'fill="{self.p["blue"]["300"]}" stroke="{self.p["blue"]["700"]}" stroke-width="1.2"/>'
        )
        self.parts.append(
            f'<rect x="{x + half:.1f}" y="{y:.1f}" width="{half:.1f}" height="{h:.1f}" rx="6" '
            f'fill="{self.p["amber"]["300"]}" stroke="{self.p["amber"]["700"]}" stroke-width="1.2"/>'
        )
        self.label(x + half / 2, y + h / 2 + 4, left, size=12.5, anchor="middle", weight="700")
        self.label(x + half + half / 2, y + h / 2 + 4, right, size=12.5, anchor="middle", weight="700")
        self.parts.append(
            f'<line x1="{x + half:.1f}" y1="{y - 8:.1f}" x2="{x + half:.1f}" y2="{y + h + 8:.1f}" '
            f'stroke="{self.p["ink"]["default"]}" stroke-width="2.5"/>'
            f'<circle cx="{x + half:.1f}" cy="{y + h / 2:.1f}" r="11" '
            f'fill="{self.p["surface"]["white"]}" stroke="{self.p["ink"]["default"]}" stroke-width="2.5"/>'
        )
        self.label(x + half, y + h / 2 + 3.5, "↔", size=12, anchor="middle", weight="700")

    # -- rendering ----------------------------------------------------------

    def render(self, provenance: str = "") -> str:
        head = []
        if self.title:
            head.append(
                f'<text x="26" y="32" font-family="{self._font}" font-size="17" '
                f'font-weight="800" fill="{self.p["ink"]["default"]}">'
                f"{escape(self.title)}</text>"
            )
        if self.subtitle:
            head.append(
                f'<text x="26" y="51" font-family="{self._font}" font-size="12" '
                f'fill="{self.p["ink"]["muted"]}">{escape(self.subtitle)}</text>'
            )
        foot = ""
        if provenance:
            foot = (
                f'<text x="{self.w - 20:.1f}" y="{self.h - 12:.1f}" text-anchor="end" '
                f'font-family="{self._mono}" font-size="9.5" '
                f'fill="{self.p["ink"]["rule"]}">{escape(provenance)}</text>'
            )
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w:.0f} {self.h:.0f}" '
            f'width="{self.w:.0f}" height="{self.h:.0f}" role="img">'
            f"<defs>"
            f'<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
            f'markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{self.p["brand"]["grey"]}"/>'
            f"</marker></defs>"
            f'<rect width="{self.w:.0f}" height="{self.h:.0f}" fill="{self.p["surface"]["white"]}"/>'
            + "".join(head)
            + "".join(self.parts)
            + foot
            + "</svg>"
        )
