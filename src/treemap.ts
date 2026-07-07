// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.

// Dependency-free squarified treemap layout (Bruls, Huizing & van Wijk, 2000).
// Given weighted items and a bounding rect, it packs them into sub-rectangles
// whose areas are proportional to the weights, favouring near-square tiles.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A laid-out tile: the source item plus its position and size. */
export interface Tile<T> extends Rect {
  item: T;
}

/** Worst (largest) aspect ratio in a row of given total/extreme areas. */
function worst(rowMax: number, rowMin: number, sum: number, side: number): number {
  const s2 = sum * sum;
  const side2 = side * side;
  return Math.max((side2 * rowMax) / s2, s2 / (side2 * rowMin));
}

/**
 * Lay out `data` (each with a positive `value`) inside `bounds`, returning one
 * tile per item with a non-zero value. Items are sorted by value descending;
 * zero/negative values are dropped. Tile areas sum to the area of `bounds`.
 */
export function squarify<T>(
  data: { item: T; value: number }[],
  bounds: Rect,
): Tile<T>[] {
  const positive = data.filter((d) => d.value > 0);
  const total = positive.reduce((s, d) => s + d.value, 0);
  if (total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];

  // Scale values into area units so the packed tiles fill `bounds` exactly.
  const scale = (bounds.w * bounds.h) / total;
  const nodes = positive
    .map((d) => ({ item: d.item, area: d.value * scale }))
    .sort((a, b) => b.area - a.area);

  const out: Tile<T>[] = [];
  let { x, y, w, h } = bounds;

  let start = 0;
  while (start < nodes.length) {
    // Rows are laid along the shorter side so tiles stay square-ish.
    const side = Math.min(w, h);
    let end = start;
    let rowArea = 0;
    let rowMin = Infinity;
    let rowMax = 0;
    let prevWorst = Infinity;

    // Grow the row while it keeps the worst aspect ratio from getting worse.
    while (end < nodes.length) {
      const a = nodes[end].area;
      const nextMin = Math.min(rowMin, a);
      const nextMax = Math.max(rowMax, a);
      const nextArea = rowArea + a;
      const cand = worst(nextMax, nextMin, nextArea, side);
      if (end > start && cand > prevWorst) break;
      rowMin = nextMin;
      rowMax = nextMax;
      rowArea = nextArea;
      prevWorst = cand;
      end++;
    }

    // Place the row: its thickness fills across, tiles run along `side`.
    const thickness = rowArea / side || 0;
    const horizontal = w >= h; // shorter side is the height → stack vertically
    let pos = horizontal ? y : x;
    for (let k = start; k < end; k++) {
      const len = nodes[k].area / thickness || 0;
      if (horizontal) {
        out.push({ item: nodes[k].item, x, y: pos, w: thickness, h: len });
      } else {
        out.push({ item: nodes[k].item, x: pos, y, w: len, h: thickness });
      }
      pos += len;
    }
    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    start = end;
  }

  return out;
}
