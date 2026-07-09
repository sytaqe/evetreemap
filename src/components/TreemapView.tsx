// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { KillStats, MarketGroup, MarketPrices, MarketType } from "../types.ts";
import { typeIconUrl } from "../eve.ts";
import { squarify, type Rect } from "../treemap.ts";

/** Which killmail quantity sizes the tiles: destroyed + dropped, or destroyed. */
export type TreemapMetric = "all" | "destroyed";

interface Props {
  roots: MarketGroup[];
  killStats: KillStats;
  prices: MarketPrices;
  /** Which quantity drives tile value: destroyed + dropped, or destroyed only. */
  metric: TreemapMetric;
  /**
   * Current drill path (group ids from a top-level group down to the current
   * node). Held by the parent so it survives switching views and back.
   */
  path: number[];
  /** Update the drill path. */
  onPathChange: (path: number[]) => void;
  /** Called when an item tile is clicked (e.g. to open it in Market Browser). */
  onSelectItem?: (item: MarketType) => void;
}

/** A priced leaf item: latest-day ISK value and day-over-day change. */
interface ItemValueNode {
  kind: "item";
  id: number;
  name: string;
  units: number; // latest-day quantity (destroyed [+ dropped]) that made `value`
  value: number; // latest-day quantity * average price
  prevValue: number; // previous-day equivalent, for the change color/number
  ratio: number | null; // (value - prevValue) / prevValue; null when "new"
}

/** A market group node aggregating its child groups and items. */
interface GroupValueNode {
  kind: "group";
  id: number;
  name: string;
  value: number;
  prevValue: number;
  ratio: number | null;
  iconId: number | null; // largest descendant item, used as the group icon
  children: ValueNode[]; // sorted by value descending
}

type ValueNode = ItemValueNode | GroupValueNode;

interface ValueTree {
  top: GroupValueNode[]; // top-level market groups, sorted by value descending
  byId: Map<number, GroupValueNode>; // every group node, keyed by id
  latestDate: string;
  prevDate: string | null;
}

// --- Color & formatting ---------------------------------------------------

const NEUTRAL = [55, 60, 72];
const UP = [34, 157, 94];
const DOWN = [192, 57, 43];
const COLOR_CAP = 0.4; // a ±40% move saturates the green/red

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Background color for a change ratio: green up, red down, neutral flat. */
function changeColor(ratio: number | null): string {
  if (ratio === null) return `rgb(${UP.join(",")})`; // "new" — full green
  const t = Math.max(-1, Math.min(1, ratio / COLOR_CAP));
  const to = t >= 0 ? UP : DOWN;
  const k = Math.abs(t);
  return `rgb(${lerp(NEUTRAL[0], to[0], k)},${lerp(NEUTRAL[1], to[1], k)},${lerp(
    NEUTRAL[2],
    to[2],
    k,
  )})`;
}

/**
 * Bright text color for a change label by sign only — the fully-saturated
 * green/red a ±100% move would get — so small changes stay readable on the
 * group header rather than fading toward neutral. NEW counts as up (green).
 */
function pctColor(ratio: number | null): string {
  return changeColor(ratio === null ? null : ratio >= 0 ? 1 : -1);
}

/** Signed percentage label, or "NEW" when there is no previous baseline. */
function fmtPct(ratio: number | null): string {
  if (ratio === null) return "NEW";
  const p = ratio * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

/** Compact ISK value (e.g. 1.2B, 3.4M) for tooltips. */
function fmtIsk(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "k";
  return n.toFixed(0);
}

const ratioOf = (value: number, prev: number): number | null =>
  prev > 0 ? (value - prev) / prev : value > 0 ? null : 0;

/**
 * Top-level market groups hidden from the Tree Map: cosmetics, blueprints,
 * skills and other items whose destroyed/dropped ISK is not "consumption" of
 * interest here. Matched by the group's English name.
 */
const EXCLUDED_ROOTS = new Set([
  "Apparel",
  "Blueprints & Reactions",
  "Personalization",
  "Ship SKINs",
  "Skills",
]);

// --- Model ----------------------------------------------------------------

/**
 * Build a value-annotated copy of the market tree. Each item's value is its
 * killmail quantity on the latest kill-stats day times its average price that
 * day; the quantity is `destroyed + dropped` for the `all` metric or `destroyed`
 * alone for the `destroyed` metric. The previous day is computed the same way
 * for the change. Groups aggregate their descendants; branches with no priced
 * items are pruned, so the treemap mirrors `market_tree.json`'s hierarchy (§4.1)
 * restricted to items that actually moved.
 */
function buildValueTree(
  roots: MarketGroup[],
  killStats: KillStats,
  prices: MarketPrices,
  metric: TreemapMetric,
): ValueTree {
  const dates = killStats.dates;
  const last = dates.length - 1;
  const prev = last - 1;
  const latestDate = dates[last];
  const prevDate = prev >= 0 ? dates[prev] : null;
  const byId = new Map<number, GroupValueNode>();

  const qtyOn = (stat: KillStats["items"][string], i: number): number =>
    (stat.destroyed[i] ?? 0) + (metric === "all" ? (stat.dropped[i] ?? 0) : 0);

  const itemNode = (t: MarketType): ItemValueNode | null => {
    const stat = killStats.items[String(t.id)];
    const priceLast = prices.prices[String(t.id)]?.[latestDate];
    if (!stat || !priceLast) return null;
    const units = qtyOn(stat, last);
    const value = units * priceLast;
    if (value <= 0) return null;
    const pricePrev = prevDate ? prices.prices[String(t.id)]?.[prevDate] : undefined;
    const qtyPrev = prev >= 0 ? qtyOn(stat, prev) : 0;
    const prevValue = pricePrev ? qtyPrev * pricePrev : 0;
    return {
      kind: "item",
      id: t.id,
      name: t.name,
      units,
      value,
      prevValue,
      ratio: ratioOf(value, prevValue),
    };
  };

  const groupNode = (g: MarketGroup): GroupValueNode | null => {
    const children: ValueNode[] = [];
    for (const cg of g.groups) {
      const n = groupNode(cg);
      if (n) children.push(n);
    }
    for (const t of g.types) {
      const n = itemNode(t);
      if (n) children.push(n);
    }
    if (children.length === 0) return null;

    let value = 0;
    let prevValue = 0;
    let iconId: number | null = null;
    let iconVal = -1;
    for (const c of children) {
      value += c.value;
      prevValue += c.prevValue;
      const candId = c.kind === "item" ? c.id : c.iconId;
      if (candId !== null && c.value > iconVal) {
        iconVal = c.value;
        iconId = candId;
      }
    }
    children.sort((a, b) => b.value - a.value);
    const node: GroupValueNode = {
      kind: "group",
      id: g.id,
      name: g.name,
      value,
      prevValue,
      ratio: ratioOf(value, prevValue),
      iconId,
      children,
    };
    byId.set(g.id, node);
    return node;
  };

  const top = roots
    .filter((g) => !EXCLUDED_ROOTS.has(g.name))
    .map(groupNode)
    .filter((n): n is GroupValueNode => n !== null)
    .sort((a, b) => b.value - a.value);

  return { top, byId, latestDate, prevDate };
}

// --- Size hook ------------------------------------------------------------

function useContainerSize<T extends HTMLElement>(): [
  RefObject<T>,
  { w: number; h: number },
] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

// --- Tiles ----------------------------------------------------------------

const GROUP_HEADER = 18; // px reserved for a group's label strip
const MIN_TILE = 2; // tiles smaller than this in either dimension aren't drawn
// How many market-tree levels below the current node are drawn. Items always
// render as tiles; groups deeper than this render as a single (drillable) tile
// instead of being expanded — you drill in to go further.
const MAX_LEVELS = 3;
// Faction groups are always expanded one level past the cutoff instead of
// stopping as a single tile, so their ships/items stay visible. Matched by the
// group's English name; the set covers every faction grouping in the market
// tree (empire races, empire states/navies, and pirate/special factions).
const FORCE_EXPAND = new Set([
  // Empire races (ship hulls, components)
  "Amarr",
  "Caldari",
  "Gallente",
  "Minmatar",
  // Empire states / navies (faction materials, insignias)
  "Amarr Empire",
  "Caldari State",
  "Gallente Federation",
  "Minmatar Republic",
  "Amarr Navy",
  "Caldari Navy",
  "Ammatar Navy",
  // Pirate & special factions
  "ORE",
  "Triglavian",
  "EDENCOM",
  "CONCORD",
  "Sisters of EVE",
  "Mordu's Legion",
  "Angel Cartel",
  "Angels",
  "Blood Raiders",
  "Guristas",
  "Sansha's Nation",
  "Serpentis",
]);

/**
 * A leaf rectangle for either an item or a not-expanded group: colored by the
 * change ratio and showing the icon, name and "{total} ({change})" as space
 * allows. When `units` is given (item tiles) a unit count is added on tiles tall
 * enough to fit it — i.e. once zoomed in. Clicking an item opens it (via
 * `onClick`); a group zooms into it.
 */
function Tile({
  rect,
  name,
  value,
  units,
  ratio,
  iconId,
  title,
  isGroup,
  onClick,
}: {
  rect: Rect;
  name: string;
  value: number;
  units?: number;
  ratio: number | null;
  iconId: number | null;
  title: string;
  isGroup?: boolean;
  onClick?: () => void;
}) {
  const { w, h } = rect;
  if (w < MIN_TILE || h < MIN_TILE) return null;
  const showIcon = w >= 34 && h >= 40;
  const showName = w >= 54 && h >= 30;
  const showStat = w >= 54 && h >= 46;
  const showUnits = units !== undefined && w >= 54 && h >= 62;

  // Scale the icon, text and spacing to the tile: the shorter side keeps the
  // content from overflowing either dimension. Sizes are clamped so tiny tiles
  // stay legible and huge tiles don't get absurdly large.
  const base = Math.min(w, h);
  const nameSize = clamp(base * 0.13, 11, 40);
  const statSize = clamp(base * 0.11, 9, 28);
  const iconPx = Math.round(clamp(base * 0.42, 18, 160));
  const iconSrc =
    iconPx <= 32 ? 32 : iconPx <= 64 ? 64 : iconPx <= 128 ? 128 : 256;
  const gap = clamp(base * 0.03, 2, 14);

  return (
    <button
      type="button"
      className={isGroup ? "tm-tile tm-tile-group" : "tm-tile"}
      title={title}
      style={{
        left: rect.x,
        top: rect.y,
        width: w,
        height: h,
        gap,
        padding: gap,
        background: changeColor(ratio),
      }}
      onClick={onClick}
    >
      {showIcon && iconId !== null && (
        <img
          className="tm-tile-icon"
          src={typeIconUrl(iconId, iconSrc)}
          alt=""
          loading="lazy"
          width={iconPx}
          height={iconPx}
        />
      )}
      {showName && (
        <span className="tm-tile-name" style={{ fontSize: nameSize }}>
          {name}
        </span>
      )}
      {showStat && (
        <span className="tm-tile-pct" style={{ fontSize: statSize }}>
          {fmtIsk(value)} ({fmtPct(ratio)})
        </span>
      )}
      {showUnits && (
        <span className="tm-tile-units" style={{ fontSize: statSize }}>
          {units.toLocaleString("en-US")} unit{units === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}

// --- View -----------------------------------------------------------------

export function TreemapView({
  roots,
  killStats,
  prices,
  metric,
  path,
  onPathChange,
  onSelectItem,
}: Props) {
  const setPath = onPathChange;
  const [canvasRef, size] = useContainerSize<HTMLDivElement>();

  const tree = useMemo(
    () => buildValueTree(roots, killStats, prices, metric),
    [roots, killStats, prices, metric],
  );

  // Resolve the current node from the drill path; fall back to the overview
  // (top-level groups) if the path no longer points at a live group.
  const currentGroup =
    path.length > 0 ? tree.byId.get(path[path.length - 1]) ?? null : null;
  const stalePath = path.length > 0 && !currentGroup;
  useEffect(() => {
    if (stalePath) setPath([]);
  }, [stalePath, setPath]);

  const children = currentGroup ? currentGroup.children : tree.top;
  const { w, h } = size;

  const content = useMemo(() => {
    if (children.length === 0) return null;

    // Pack a list of nodes into `rect`. Items always draw as tiles; a group is
    // drawn as an expandable section (frame + header + its children) until it is
    // `MAX_LEVELS` below the current node, at which point it draws as a single
    // drillable tile instead of being expanded further. `depth` counts levels
    // below the current node (its direct children are depth 1).
    // Returns the rendered elements plus how many tiles were actually drawn: a
    // section whose whole subtree draws nothing (all sub-pixel) is omitted too.
    const layout = (
      nodes: ValueNode[],
      rect: Rect,
      basePath: number[],
      depth: number,
    ): { els: ReactNode[]; count: number } => {
      const els: ReactNode[] = [];
      let count = 0;
      const tiles = squarify(
        nodes.map((n) => ({ item: n, value: n.value })),
        rect,
      );
      for (const t of tiles) {
        const n = t.item;

        // Item, or a group at the depth cutoff → a single tile. Empire faction
        // groups are exempt from the cutoff and always expand one level more.
        const forced = n.kind === "group" && FORCE_EXPAND.has(n.name);
        if (n.kind === "item" || (depth >= MAX_LEVELS && !forced)) {
          if (t.w < MIN_TILE || t.h < MIN_TILE) continue;
          if (n.kind === "item") {
            els.push(
              <Tile
                key={`i${n.id}`}
                rect={t}
                name={n.name}
                value={n.value}
                units={n.units}
                ratio={n.ratio}
                iconId={n.id}
                title={`${n.name}\nValue: ${fmtIsk(n.value)} ISK\nUnits: ${n.units.toLocaleString(
                  "en-US",
                )}\nChange: ${fmtPct(n.ratio)}`}
                onClick={
                  onSelectItem
                    ? () => onSelectItem({ id: n.id, name: n.name })
                    : undefined
                }
              />,
            );
          } else {
            const nodePath = [...basePath, n.id];
            els.push(
              <Tile
                key={`g${n.id}`}
                rect={t}
                name={n.name}
                value={n.value}
                ratio={n.ratio}
                iconId={n.iconId}
                isGroup
                title={`${n.name}\nValue: ${fmtIsk(n.value)} ISK\nChange: ${fmtPct(
                  n.ratio,
                )}`}
                onClick={() => setPath(nodePath)}
              />,
            );
          }
          count++;
          continue;
        }

        // Group above the cutoff → an expandable section.
        const nodePath = [...basePath, n.id];
        const showHeader = t.w > 48 && t.h > 42;
        const headH = showHeader ? GROUP_HEADER : 0;
        const body: Rect = { x: t.x, y: t.y + headH, w: t.w, h: t.h - headH };
        const child =
          body.w >= MIN_TILE && body.h >= MIN_TILE
            ? layout(n.children, body, nodePath, depth + 1)
            : { els: [] as ReactNode[], count: 0 };
        // Nothing rendered below this group → hide the group itself too.
        if (child.count === 0) continue;

        els.push(
          <div
            key={`f${n.id}`}
            className="tm-group-frame"
            style={{ left: t.x, top: t.y, width: t.w, height: t.h }}
          />,
        );
        if (showHeader) {
          els.push(
            <button
              key={`h${n.id}`}
              type="button"
              className="tm-group-header"
              title={`${n.name}\nValue: ${fmtIsk(n.value)} ISK\nChange: ${fmtPct(
                n.ratio,
              )}\n(click to zoom in)`}
              style={{ left: t.x, top: t.y, width: t.w, height: GROUP_HEADER }}
              onClick={() => setPath(nodePath)}
            >
              {n.iconId !== null && (
                <img
                  className="tm-group-icon"
                  src={typeIconUrl(n.iconId, 32)}
                  alt=""
                  loading="lazy"
                  width={14}
                  height={14}
                />
              )}
              <span className="tm-group-name">{n.name}</span>
              <span
                className="tm-group-pct"
                style={{ color: pctColor(n.ratio) }}
              >
                {fmtPct(n.ratio)}
              </span>
            </button>,
          );
        }
        els.push(...child.els);
        count += child.count;
      }
      return { els, count };
    };

    return layout(children, { x: 0, y: 0, w, h }, path, 1).els;
  }, [children, path, w, h, onSelectItem]);

  const crumbs = path.map((id) => ({ id, name: tree.byId.get(id)?.name ?? "?" }));

  return (
    <div className="treemap-view">
      <div className="treemap-toolbar">
        <nav className="treemap-crumb" aria-label="Treemap breadcrumb">
          <button
            type="button"
            className="treemap-crumb-btn"
            onClick={() => setPath([])}
            disabled={path.length === 0}
          >
            All groups
          </button>
          {crumbs.map((c, i) => (
            <span key={c.id} className="treemap-crumb-step">
              <span className="treemap-crumb-sep">▸</span>
              {i === crumbs.length - 1 ? (
                <span className="treemap-crumb-current">{c.name}</span>
              ) : (
                <button
                  type="button"
                  className="treemap-crumb-link"
                  onClick={() => setPath(path.slice(0, i + 1))}
                >
                  {c.name}
                </button>
              )}
            </span>
          ))}
        </nav>
        <p className="treemap-note">
          Sized by ISK value (
          {metric === "all" ? "destroyed + dropped" : "destroyed"} × The Forge
          price) on {tree.latestDate}
          {tree.prevDate
            ? `. Color = change vs ${tree.prevDate} (green up, red down).`
            : "."}
        </p>
      </div>
      <div className="treemap-canvas" ref={canvasRef}>
        {children.length === 0 ? (
          <p className="status">
            No priced destroyed/dropped items on {tree.latestDate}.
          </p>
        ) : (
          content
        )}
      </div>
    </div>
  );
}
