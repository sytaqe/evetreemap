// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.
import { useEffect, useState } from "react";
import type { KillStats, MarketType } from "../types.ts";
import {
  fetchMarketHistory,
  typeImageUrl,
  THE_FORGE_REGION_ID,
  type MarketHistoryEntry,
} from "../eve.ts";
import { MarketHistoryChart, type KillPoint } from "./MarketHistoryChart.tsx";

interface Props {
  item: MarketType | null;
  killStats: KillStats | null;
}

/** Days summed for the "recent total" kill card. */
const RECENT_DAYS = 7;
const num = (n: number) => n.toLocaleString("en-US");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "ready"; data: MarketHistoryEntry[] };

/**
 * Right-pane detail view: the selected item's image and name, plus a chart of
 * daily average price and traded volume in The Forge region.
 */
export function ItemDetail({ item, killStats }: Props) {
  const [history, setHistory] = useState<HistoryState | null>(null);

  useEffect(() => {
    if (!item) {
      setHistory(null);
      return;
    }
    const controller = new AbortController();
    setHistory({ status: "loading" });

    fetchMarketHistory(THE_FORGE_REGION_ID, item.id, controller.signal)
      .then((rows) =>
        setHistory(
          rows.length === 0 ? { status: "empty" } : { status: "ready", data: rows },
        ),
      )
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setHistory({
          status: "error",
          message: e instanceof Error ? e.message : "Failed to load market history",
        });
      });

    return () => controller.abort();
  }, [item?.id]);

  if (!item) {
    return (
      <div className="detail detail-empty">
        <p>Select an item from the market tree to see its details.</p>
      </div>
    );
  }

  // Per-day kill points for this item (zeros when the item has no records),
  // aligned by date so the chart can overlay them onto the price timeline.
  const killSeries: KillPoint[] | null = killStats
    ? killStats.dates.map((date, i) => {
        const stat = killStats.items[String(item.id)];
        return {
          date,
          destroyed: stat?.destroyed[i] ?? 0,
          dropped: stat?.dropped[i] ?? 0,
        };
      })
    : null;

  // Kill-count summary cards: the latest day and the sum of the last N days.
  // Data may hold more than N days (old days accumulate), so slice the tail.
  let killCards: {
    latestDate: string;
    latestDestroyed: number;
    latestDropped: number;
    recentDestroyed: number;
    recentDropped: number;
  } | null = null;
  if (killStats && killStats.dates.length > 0) {
    const stat = killStats.items[String(item.id)];
    const n = killStats.dates.length;
    const last = n - 1;
    const from = Math.max(0, n - RECENT_DAYS);
    killCards = {
      latestDate: killStats.dates[last],
      latestDestroyed: stat?.destroyed[last] ?? 0,
      latestDropped: stat?.dropped[last] ?? 0,
      recentDestroyed: stat ? sum(stat.destroyed.slice(from)) : 0,
      recentDropped: stat ? sum(stat.dropped.slice(from)) : 0,
    };
  }

  // When kill data is present, clip the price history to the kill window so the
  // chart covers only that period (out-of-range days are hidden).
  const readyData = history?.status === "ready" ? history.data : null;
  const chartData =
    readyData && killStats
      ? readyData.filter(
          (d) => d.date >= killStats.from && d.date <= killStats.to,
        )
      : readyData;

  return (
    <div className="detail">
      <div className="detail-head">
        <img
          className="detail-image"
          src={typeImageUrl(item.id, 128)}
          alt={item.name}
          width={128}
          height={128}
        />
        <div>
          <h2 className="detail-name">{item.name}</h2>
          <p className="detail-meta">Type ID: {item.id}</p>
        </div>

        {killCards && (
          <div className="kill-cards">
            <div className="kill-card">
              <span className="kill-card-title">
                Latest day ({killCards.latestDate})
              </span>
              <span className="kill-card-row kill-destroyed">
                Destroyed <b>{num(killCards.latestDestroyed)}</b>
              </span>
              <span className="kill-card-row kill-dropped">
                Dropped <b>{num(killCards.latestDropped)}</b>
              </span>
            </div>
            <div className="kill-card">
              <span className="kill-card-title">Last {RECENT_DAYS} days</span>
              <span className="kill-card-row kill-destroyed">
                Destroyed <b>{num(killCards.recentDestroyed)}</b>
              </span>
              <span className="kill-card-row kill-dropped">
                Dropped <b>{num(killCards.recentDropped)}</b>
              </span>
            </div>
          </div>
        )}
      </div>

      <section className="detail-history">
        <h3 className="detail-section-title">
          Market history — The Forge (region {THE_FORGE_REGION_ID})
        </h3>
        {killStats && (
          <p className="detail-note">
            Limited to the kill window {killStats.from} to {killStats.to}.
            Destroyed/dropped are all-region daily totals from{" "}
            {num(killStats.killmails_processed)} sampled killmails.
          </p>
        )}
        {history?.status === "loading" && (
          <p className="status">Loading market history…</p>
        )}
        {history?.status === "error" && (
          <p className="status status-error">Error: {history.message}</p>
        )}
        {history?.status === "empty" && (
          <p className="status">No market history recorded for this item.</p>
        )}
        {history?.status === "ready" &&
          (chartData && chartData.length > 0 ? (
            <MarketHistoryChart data={chartData} kills={killSeries} />
          ) : (
            <p className="status">No market history in the kill window.</p>
          ))}
      </section>
    </div>
  );
}
