// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.

// Helpers for EVE Online image/data services.
// The image server is a public, key-less CDN and needs no ESI authentication.
const IMAGE_SERVER = "https://images.evetech.net";

/** URL of an item type's icon at the requested size (32, 64, 128, 256, 512). */
export function typeIconUrl(typeId: number, size = 64): string {
  return `${IMAGE_SERVER}/types/${typeId}/icon?size=${size}`;
}

/** URL of an item type's large render/icon for the detail pane. */
export function typeImageUrl(typeId: number, size = 256): string {
  return `${IMAGE_SERVER}/types/${typeId}/icon?size=${size}`;
}

// --- ESI market data (public, key-less endpoints; CORS-enabled) ---
const ESI_BASE = "https://esi.evetech.net/latest";

/** The Forge — EVE's primary trade hub region (contains Jita). */
export const THE_FORGE_REGION_ID = 10000002;

/** One daily aggregate row from GET /markets/{region_id}/history/. */
export interface MarketHistoryEntry {
  date: string; // YYYY-MM-DD
  average: number;
  highest: number;
  lowest: number;
  order_count: number;
  volume: number;
}

/**
 * Fetch daily market history for a type in a region, ordered ascending by date.
 * Returns an empty array when the type has no recorded history in the region.
 */
export async function fetchMarketHistory(
  regionId: number,
  typeId: number,
  signal?: AbortSignal,
): Promise<MarketHistoryEntry[]> {
  const url = `${ESI_BASE}/markets/${regionId}/history/?type_id=${typeId}`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ESI HTTP ${res.status}`);
  const rows = (await res.json()) as MarketHistoryEntry[];
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}
