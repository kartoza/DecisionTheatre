/**
 * Which pane carries the zoom cluster.
 *
 * Every map drew its own zoom in / zoom out / compass control at the bottom
 * left, so a six-pane grid drew six of them. They are not six controls: every
 * map in the grid is registered with useMapSync, and moving any one moves all
 * the others, so all six did the same thing to all six maps. One is enough.
 *
 * It goes to the bottom-left map — furthest from the panes' own controls at the
 * top and bottom right, and the corner a hand reaches for on a scrolled grid.
 * "Bottom-left" is resolved against what is actually showing a map: a grid
 * whose bottom-left widget is a chart still needs a zoom control somewhere, so
 * the search walks up and to the right until it finds one.
 */
export function navigationPaneIndex(
  visibleIndices: number[],
  columns: number,
  isMapPane: (paneIndex: number) => boolean,
): number | null {
  if (columns < 1) return null;

  const rows = Math.ceil(visibleIndices.length / columns);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = 0; column < columns; column += 1) {
      const position = row * columns + column;
      if (position >= visibleIndices.length) continue;
      const paneIndex = visibleIndices[position];
      if (isMapPane(paneIndex)) return paneIndex;
    }
  }
  return null;
}
