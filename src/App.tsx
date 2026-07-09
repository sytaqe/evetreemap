// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.
import { useEffect, useState } from "react";
import type {
  KillDayFile,
  KillIndex,
  KillItemStat,
  KillStats,
  MarketPrices,
  MarketTree,
  MarketType,
} from "./types.ts";
import { MarketTreeView } from "./components/MarketTreeView.tsx";
import { ItemDetail } from "./components/ItemDetail.tsx";
import { TreemapView } from "./components/TreemapView.tsx";
import "./App.css";

/** Which top-level view is shown. The two treemap views differ only in the
 * metric that sizes the tiles: destroyed + dropped, or destroyed only. */
type View = "market" | "treemapAll" | "treemapDestroyed";

/** URL hash slug for each view, so a link like `.../#treemap-all` opens it. */
const VIEW_HASH: Record<View, string> = {
  market: "market",
  treemapAll: "treemap-all",
  treemapDestroyed: "treemap-destroyed",
};

/**
 * Parse a URL hash into a view (defaults to Tree Map (All) for unknowns). Only
 * the first `/`-separated segment names the view; the rest is the drill path.
 */
function hashToView(hash: string): View {
  switch (hash.replace(/^#/, "").split("/")[0].toLowerCase()) {
    case "market":
    case "market-browser":
      return "market";
    case "treemap-destroyed":
    case "treemapdestroyed":
    case "destroyed":
      return "treemapDestroyed";
    default:
      return "treemapAll";
  }
}

/**
 * Parse the treemap drill path (group ids) from the segments after the view
 * slug, e.g. `#treemap-all/9/16` → `[9, 16]`. Non-numeric segments are dropped.
 */
function hashToPath(hash: string): number[] {
  return hash
    .replace(/^#/, "")
    .split("/")
    .slice(1)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
}

/** Build the canonical hash for a view and (for treemap views) its drill path. */
function toHash(view: View, path: number[]): string {
  const suffix = view !== "market" && path.length ? `/${path.join("/")}` : "";
  return `#${VIEW_HASH[view]}${suffix}`;
}

/** Merge the kill index and its per-day files into a single daily series. */
function mergeKillStats(
  index: KillIndex,
  days: (KillDayFile | null)[],
): KillStats | null {
  const loaded = index.dates
    .map((date, i) => ({ date, day: days[i] }))
    .filter((x): x is { date: string; day: KillDayFile } => x.day !== null);
  if (loaded.length === 0) return null;

  const dates = loaded.map((x) => x.date);
  const items: Record<string, KillItemStat> = {};
  let processed = 0;
  let failed = 0;

  loaded.forEach(({ day }, i) => {
    processed += day.killmails_processed;
    failed += day.killmails_failed;
    for (const [tid, v] of Object.entries(day.items)) {
      const entry = (items[tid] ??= {
        destroyed: Array(dates.length).fill(0),
        dropped: Array(dates.length).fill(0),
      });
      entry.destroyed[i] = v.destroyed;
      entry.dropped[i] = v.dropped;
    }
  });

  return {
    generated: index.generated,
    source: index.source,
    region: index.region,
    from: dates[0],
    to: dates[dates.length - 1],
    days: dates.length,
    dates,
    killmails_processed: processed,
    killmails_failed: failed,
    items,
  };
}

export default function App() {
  const [tree, setTree] = useState<MarketTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarketType | null>(null);
  const [killStats, setKillStats] = useState<KillStats | null>(null);
  const [prices, setPrices] = useState<MarketPrices | null>(null);
  // The view and treemap drill path are both driven by the URL hash
  // (`#<view>/<id>/<id>/…`), so a link can open a specific mode at a specific
  // drill position and Back/Forward step through it. The path is held here (not
  // in TreemapView) so it survives switching to the Market Browser and back.
  const [view, setView] = useState<View>(() => hashToView(window.location.hash));
  const [treemapPath, setTreemapPath] = useState<number[]>(() =>
    hashToPath(window.location.hash),
  );

  // Normalize the hash once on load, then follow Back/Forward (popstate) and
  // manual hash edits (hashchange) by re-reading the view and path from it. A
  // market hash carries no path, so the drill position is left untouched there.
  useEffect(() => {
    const sync = () => {
      const hash = window.location.hash;
      const nextView = hashToView(hash);
      setView(nextView);
      if (nextView !== "market") setTreemapPath(hashToPath(hash));
    };
    const canonical = toHash(
      hashToView(window.location.hash),
      hashToPath(window.location.hash),
    );
    if (window.location.hash !== canonical) {
      window.history.replaceState(null, "", canonical);
    }
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  // Write the hash for a view + drill path. `push` adds a history entry (drilling
  // in, opening an item) so Back steps through; otherwise it replaces the current
  // entry (top-level mode switches) so those don't pile up in history.
  const writeHash = (nextView: View, nextPath: number[], push: boolean) => {
    const hash = toHash(nextView, nextPath);
    if (window.location.hash === hash) return;
    if (push) window.history.pushState(null, "", hash);
    else window.history.replaceState(null, "", hash);
  };

  // Top-level mode switch (nav buttons): replace, carrying the current path.
  const selectView = (v: View) => {
    setView(v);
    writeHash(v, treemapPath, false);
  };

  // Drill / breadcrumb navigation: push so Back returns to the previous level.
  const drillTo = (nextPath: number[]) => {
    setTreemapPath(nextPath);
    writeHash(view, nextPath, true);
  };

  useEffect(() => {
    const url = `${import.meta.env.BASE_URL}data/market_tree.json`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MarketTree>;
      })
      .then(setTree)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load market data"),
      );
  }, []);

  // Kill statistics are optional: load the index, then each day file in
  // parallel, and merge them. If the index is absent the feature is hidden.
  useEffect(() => {
    const base = `${import.meta.env.BASE_URL}data/kill_stats/`;
    (async () => {
      try {
        const idxRes = await fetch(`${base}index.json`);
        if (!idxRes.ok) return;
        const index = (await idxRes.json()) as KillIndex;
        const days = await Promise.all(
          index.dates.map((d) =>
            fetch(`${base}${d}.json`)
              .then((r) => (r.ok ? (r.json() as Promise<KillDayFile>) : null))
              .catch(() => null),
          ),
        );
        setKillStats(mergeKillStats(index, days));
      } catch {
        setKillStats(null);
      }
    })();
  }, []);

  // Market prices are optional too: they drive the treemap's tile sizes. When
  // absent the Tree Map view degrades to a message.
  useEffect(() => {
    const url = `${import.meta.env.BASE_URL}data/market_prices.json`;
    fetch(url)
      .then((res) => (res.ok ? (res.json() as Promise<MarketPrices>) : null))
      .then(setPrices)
      .catch(() => setPrices(null));
  }, []);

  const openInMarket = (item: MarketType) => {
    setSelected(item);
    setView("market");
    // Push so Back returns to the treemap at the same drill position.
    writeHash("market", treemapPath, true);
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>EVE Treemap</h1>
        <nav className="app-nav" aria-label="View">
          <button
            type="button"
            className={`app-nav-link ${view === "treemapAll" ? "active" : ""}`}
            aria-current={view === "treemapAll" ? "page" : undefined}
            onClick={() => selectView("treemapAll")}
          >
            Tree Map (All)
          </button>
          <button
            type="button"
            className={`app-nav-link ${
              view === "treemapDestroyed" ? "active" : ""
            }`}
            aria-current={view === "treemapDestroyed" ? "page" : undefined}
            onClick={() => selectView("treemapDestroyed")}
          >
            Tree Map (Destroyed)
          </button>
          <button
            type="button"
            className={`app-nav-link ${view === "market" ? "active" : ""}`}
            aria-current={view === "market" ? "page" : undefined}
            onClick={() => selectView("market")}
          >
            Market Browser
          </button>
        </nav>
      </header>

      {view === "market" ? (
        <div className="app-body">
          <aside className="pane pane-tree">
            {error && <p className="status status-error">Error: {error}</p>}
            {!error && !tree && <p className="status">Loading market data…</p>}
            {tree && (
              <MarketTreeView
                roots={tree.roots}
                selectedId={selected?.id ?? null}
                onSelect={setSelected}
              />
            )}
          </aside>
          <main className="pane pane-detail">
            <ItemDetail item={selected} killStats={killStats} />
          </main>
        </div>
      ) : (
        <div className="app-body">
          <main className="pane pane-treemap">
            {tree && killStats && prices ? (
              <TreemapView
                roots={tree.roots}
                killStats={killStats}
                prices={prices}
                metric={view === "treemapDestroyed" ? "destroyed" : "all"}
                path={treemapPath}
                onPathChange={drillTo}
                onSelectItem={openInMarket}
              />
            ) : (
              <p className="status">
                {error
                  ? `Error: ${error}`
                  : "Loading treemap data (market tree, kill statistics, and prices)…"}
              </p>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
