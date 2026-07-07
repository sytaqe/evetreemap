// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { MarketHistoryEntry } from "../eve.ts";

/** One day of destroyed/dropped quantities for the selected item. */
export interface KillPoint {
  date: string; // YYYY-MM-DD
  destroyed: number;
  dropped: number;
}

interface Props {
  data: MarketHistoryEntry[];
  kills?: KillPoint[] | null;
}

// Chart geometry. The viewBox width tracks the container's pixel width (see
// useContainerWidth) so the chart fills the full pane width at a fixed height.
const H = 300;
const TOP = 16;
const BOTTOM = 40;
const LEFT = 68;
const RIGHT_BASE = 64; // room for the volume (inner-right) axis
const RIGHT_KILLS = 120; // wider right margin for the extra kills axis
const innerH = H - TOP - BOTTOM;
const MIN_W = 320;

/** Track a container element's content-box width, updating on resize. */
function useContainerWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(680);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.max(w, MIN_W));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Compact number formatting for axis labels (e.g. 1.2M, 3.4k). */
function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return abs >= 10 || n === 0 ? n.toFixed(0) : n.toFixed(2);
}

function ticks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, i) => min + step * i);
}

/**
 * Line chart of daily ISK average (left axis) and traded volume (right axis).
 * When `kills` is supplied, daily destroyed/dropped quantities are overlaid on
 * a third axis (outer right), aligned to the price timeline by date.
 */
export function MarketHistoryChart({ data, kills }: Props) {
  const [wrapRef, W] = useContainerWidth<HTMLElement>();
  const hasKills = !!kills && kills.length > 0;
  const right = hasKills ? RIGHT_KILLS : RIGHT_BASE;
  const innerW = W - LEFT - right;
  const n = data.length;

  const avgMax = Math.max(...data.map((d) => d.average));
  const avgMin = Math.min(...data.map((d) => d.average));
  const volMax = Math.max(...data.map((d) => d.volume), 1);

  // Pad the ISK axis a little so the line doesn't touch the frame.
  const aLo = avgMin === avgMax ? avgMin * 0.95 : avgMin;
  const aHi = avgMin === avgMax ? avgMax * 1.05 || 1 : avgMax;

  const x = (i: number) => LEFT + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAvg = (v: number) =>
    TOP + innerH - (aHi === aLo ? innerH / 2 : ((v - aLo) / (aHi - aLo)) * innerH);
  const yVol = (v: number) => TOP + innerH - (v / volMax) * innerH;

  const avgPath = data.map((d, i) => `${x(i)},${yAvg(d.average)}`).join(" ");
  const volPath = data.map((d, i) => `${x(i)},${yVol(d.volume)}`).join(" ");

  const yAvgTicks = ticks(aLo, aHi, 4);
  const yVolTicks = ticks(0, volMax, 4);

  // Map kill days onto the price timeline by matching dates to their index.
  const dateIndex = new Map(data.map((d, i) => [d.date, i]));
  const killPoints = (kills ?? [])
    .map((k) => {
      const idx = dateIndex.get(k.date);
      return idx === undefined
        ? null
        : { x: x(idx), destroyed: k.destroyed, dropped: k.dropped };
    })
    .filter((p): p is { x: number; destroyed: number; dropped: number } => p !== null)
    .sort((a, b) => a.x - b.x);
  // Stacked bars: the axis spans the tallest destroyed+dropped total per day.
  const killMax = Math.max(1, ...killPoints.map((p) => p.destroyed + p.dropped));
  const yKill = (v: number) => TOP + innerH - (v / killMax) * innerH;
  const yKillTicks = ticks(0, killMax, 4);
  // One vertical bar per day, ~60% of the spacing between days (capped).
  const killSpacing =
    killPoints.length >= 2 ? killPoints[1].x - killPoints[0].x : innerW / 8;
  const barWidth = Math.max(2, Math.min(killSpacing * 0.6, 40));

  // Up to 6 evenly spaced date labels along the x axis. For short windows show
  // the day (MM-DD); for long spans show the month (YYYY-MM).
  const xTickCount = Math.min(6, n);
  const xTicks = Array.from({ length: xTickCount }, (_, i) =>
    xTickCount <= 1 ? 0 : Math.round((i / (xTickCount - 1)) * (n - 1)),
  );
  const xLabel = (date: string) => (n <= 31 ? date.slice(5) : date.slice(0, 7));

  return (
    <figure className="chart" ref={wrapRef}>
      <figcaption className="chart-legend">
        <span className="legend-item">
          <span className="swatch swatch-avg" /> Average price (ISK)
        </span>
        <span className="legend-item">
          <span className="swatch swatch-vol" /> Volume (units)
        </span>
        {hasKills && (
          <>
            <span className="legend-item">
              <span className="swatch swatch-destroyed" /> Destroyed/day (units)
            </span>
            <span className="legend-item">
              <span className="swatch swatch-dropped" /> Dropped/day (units)
            </span>
          </>
        )}
      </figcaption>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Daily average price and traded volume, with destroyed and dropped quantities overlaid"
      >
        {/* Horizontal gridlines + left (ISK) axis labels */}
        {yAvgTicks.map((t, i) => {
          const y = yAvg(t);
          return (
            <g key={`ga${i}`}>
              <line className="grid" x1={LEFT} x2={LEFT + innerW} y1={y} y2={y} />
              <text className="axis-label axis-left" x={LEFT - 8} y={y}>
                {compact(t)}
              </text>
            </g>
          );
        })}

        {/* Right (volume) axis labels */}
        {yVolTicks.map((t, i) => (
          <text
            key={`gv${i}`}
            className="axis-label axis-right"
            x={LEFT + innerW + 8}
            y={yVol(t)}
          >
            {compact(t)}
          </text>
        ))}

        {/* Outer-right (kills) axis labels */}
        {hasKills &&
          yKillTicks.map((t, i) => (
            <text
              key={`gk${i}`}
              className="axis-label axis-kills"
              x={LEFT + innerW + 56}
              y={yKill(t)}
            >
              {compact(t)}
            </text>
          ))}

        {/* X axis date labels */}
        {xTicks.map((idx, i) => (
          <text
            key={`gx${i}`}
            className="axis-label axis-x"
            x={x(idx)}
            y={TOP + innerH + 20}
          >
            {data[idx] ? xLabel(data[idx].date) : ""}
          </text>
        ))}

        {/* Daily destroyed/dropped stacked bars (destroyed at the bottom,
            dropped stacked on top), drawn behind the price lines. */}
        {hasKills &&
          killPoints.map((p, i) => {
            const base = yKill(0);
            const yDestroyed = yKill(p.destroyed);
            const yTotal = yKill(p.destroyed + p.dropped);
            return (
              <g key={`kb${i}`}>
                {p.destroyed > 0 && (
                  <rect
                    className="bar bar-destroyed"
                    x={p.x - barWidth / 2}
                    y={yDestroyed}
                    width={barWidth}
                    height={base - yDestroyed}
                  />
                )}
                {p.dropped > 0 && (
                  <rect
                    className="bar bar-dropped"
                    x={p.x - barWidth / 2}
                    y={yTotal}
                    width={barWidth}
                    height={yDestroyed - yTotal}
                  />
                )}
              </g>
            );
          })}

        {/* Price/volume lines (on top of the bars) */}
        <polyline className="line line-vol" points={volPath} />
        <polyline className="line line-avg" points={avgPath} />
      </svg>
    </figure>
  );
}
