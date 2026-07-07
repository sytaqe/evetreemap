// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.

/** A tradeable item type that belongs to a market group. */
export interface MarketType {
  id: number;
  name: string;
}

/** A market group node with child groups and directly-contained item types. */
export interface MarketGroup {
  id: number;
  name: string;
  iconID: number | null;
  groups: MarketGroup[];
  types: MarketType[];
}

/** Top-level payload emitted by scripts/build_market_tree.py. */
export interface MarketTree {
  build: number | null;
  roots: MarketGroup[];
}

/** Per-day destroyed/dropped quantities for a single item type. */
export interface KillItemStat {
  /** Units destroyed, one entry per day in KillStats.dates. */
  destroyed: number[];
  /** Units dropped, one entry per day in KillStats.dates. */
  dropped: number[];
}

/** index.json emitted alongside the per-day kill files. */
export interface KillIndex {
  generated: string;
  source: string;
  region: string;
  /** Available day files, as YYYY-MM-DD (each has a matching <date>.json). */
  dates: string[];
}

/** A single per-day kill file: destroyed/dropped totals for that day. */
export interface KillDayFile {
  date: string;
  generated: string;
  region: string;
  killmails_processed: number;
  killmails_failed: number;
  items: Record<string, { destroyed: number; dropped: number }>;
}

/**
 * Daily average market prices emitted by scripts/build_market_prices.py.
 * `prices` maps a type id (string) to a map of `YYYY-MM-DD` → average ISK price
 * (The Forge region by default). Only days present in a type's history appear.
 */
export interface MarketPrices {
  generated: string;
  region: number;
  from: string;
  to: string;
  dates: string[];
  prices: Record<string, Record<string, number>>;
}

/** Aggregated killmail statistics emitted by scripts/build_kill_stats.py. */
export interface KillStats {
  generated: string;
  source: string;
  region: string;
  from: string;
  to: string;
  days: number;
  /** Calendar days (YYYY-MM-DD) the per-item arrays are aligned to. */
  dates: string[];
  killmails_processed: number;
  killmails_failed: number;
  items: Record<string, KillItemStat>;
}
