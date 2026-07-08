# SPDX-License-Identifier: CC0-1.0
# This file is released into the public domain under the CC0 1.0 Universal license.
"""Precompute daily average market prices for items that appear in kill_stats.

The Treemap view sizes each item's tile by ``(destroyed + dropped) * average
price`` on the most recent kill-stats day, and colors it by the change versus
the previous day. That needs an average price for (potentially) every item that
was destroyed/dropped — far too many items to fetch from ESI in the browser at
view time. So this script precomputes them out of band, mirroring the
``build_kill_stats.py`` convention: fetch once, commit the JSON, serve it
statically.

Pipeline:

1. Read ``public/data/kill_stats/index.json`` for the kill window (``dates``).
2. Collect the item type ids to price: by default the union of the items in the
   latest two day files (what the treemap needs), or every day in the window
   with ``--all-window``.
3. For each type, fetch a per-day average price for each window date:
   - **Capital ships** (types under the *Ships → Capital Ships* market group in
     ``market_tree.json``) are priced from zKillboard's Prices API
     (``GET https://zkillboard.com/api/prices/{id}/``) — they trade thinly or not
     at all on the Forge market. zKB returns ``{ "<date>": price, …,
     "currentPrice": "…" }``; its daily history can be stale for capitals, so any
     window date it lacks falls back to ``currentPrice``.
   - **Everything else** uses ESI ``GET /markets/{region}/history/?type_id={id}``
     (The Forge by default), keeping the ``average`` for each window date present.
4. Write ``public/data/market_prices.json``:
   ``{ generated, region, from, to, dates, prices: { "<typeID>": { "<date>": avg } } }``.

Writes are idempotent (ignoring the ``generated`` timestamp), so a no-op run
produces no git diff. Fetches run on a thread pool that paces itself to ESI's
rate/error limits, like the killmail script.

Usage:
    python scripts/build_market_prices.py                 # latest+prev day items
    python scripts/build_market_prices.py --all-window    # every item in window
    python scripts/build_market_prices.py --region 10000002
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from esi_env import user_agent

REPO_ROOT = Path(__file__).resolve().parent.parent
KILL_DIR = REPO_ROOT / "public" / "data" / "kill_stats"
MARKET_TREE = REPO_ROOT / "public" / "data" / "market_tree.json"
DEFAULT_OUT = REPO_ROOT / "public" / "data" / "market_prices.json"

# The Forge (contains Jita) — EVE's primary trade hub region.
THE_FORGE_REGION_ID = 10000002
ESI_HISTORY = "https://esi.evetech.net/latest/markets/{region}/history/?type_id={tid}"
# Capital ships are priced from zKillboard instead of ESI (thin Forge market).
ZKB_PRICES = "https://zkillboard.com/api/prices/{tid}/"


class RateGate:
    """Paces all worker threads and backs off on ESI error-limit signals.

    The market-history endpoint is generous, so this is intentionally lighter
    than the killmail gate: a minimum spacing between requests plus a shared
    pause whenever ESI reports the error limit is nearly exhausted (or 420).
    """

    def __init__(self, min_interval: float, min_error_remain: int):
        self.min_interval = min_interval
        self.min_error_remain = min_error_remain
        self._lock = threading.Lock()
        self._next = 0.0
        self._pause_until = 0.0

    def acquire(self):
        while True:
            with self._lock:
                now = time.monotonic()
                wait = max(self._next - now, self._pause_until - now)
                if wait <= 0:
                    self._next = max(now, self._next) + self.min_interval
                    return
            time.sleep(wait)

    def pause(self, seconds: float):
        with self._lock:
            self._pause_until = max(self._pause_until, time.monotonic() + seconds)

    def note_headers(self, headers):
        """Back off briefly when the ESI error budget runs low."""
        remain = headers.get("X-ESI-Error-Limit-Remain")
        reset = headers.get("X-ESI-Error-Limit-Reset")
        try:
            if remain is not None and int(remain) <= self.min_error_remain:
                self.pause(float(reset) if reset else 1.0)
        except (TypeError, ValueError):
            pass


def load_index() -> dict:
    path = KILL_DIR / "index.json"
    if not path.exists():
        sys.exit(f"error: {path} not found — run build_kill_stats.py first.")
    return json.loads(path.read_text(encoding="utf-8"))


def collect_type_ids(dates: list[str], all_window: bool) -> set[int]:
    """Union of item type ids over the relevant day files."""
    use = dates if all_window else dates[-2:]
    ids: set[int] = set()
    for date in use:
        path = KILL_DIR / f"{date}.json"
        if not path.exists():
            continue
        day = json.loads(path.read_text(encoding="utf-8"))
        ids.update(int(tid) for tid in day.get("items", {}))
    return ids


def load_capital_ship_ids() -> set[int]:
    """Type ids under the *Ships → Capital Ships* market group.

    Read from the committed ``market_tree.json``; these are priced from
    zKillboard rather than ESI. Returns an empty set if the tree or the group is
    missing (then everything falls back to ESI).
    """
    if not MARKET_TREE.exists():
        return set()

    def collect(group: dict) -> set[int]:
        ids = {t["id"] for t in group.get("types", [])}
        for g in group.get("groups", []):
            ids |= collect(g)
        return ids

    tree = json.loads(MARKET_TREE.read_text(encoding="utf-8"))
    for root in tree.get("roots", []):
        if root.get("name") == "Ships":
            for g in root.get("groups", []):
                if g.get("name") == "Capital Ships":
                    return collect(g)
    return set()


def fetch_zkb_prices(tid: int, gate: RateGate, ua: str, retries: int = 4):
    """Fetch a type's zKillboard price map ``{date: price, currentPrice: str}``.

    Returns the parsed dict, ``{}`` when zKB has no data (404), or ``None`` on
    give-up. zKB doesn't send ESI's error-limit headers, so we only back off on
    an explicit ``429``.
    """
    url = ZKB_PRICES.format(tid=tid)
    for attempt in range(retries):
        gate.acquire()
        req = urllib.request.Request(
            url, headers={"User-Agent": ua, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry_after = e.headers.get("Retry-After")
                gate.pause(float(retry_after) if retry_after else 5.0)
                continue
            if e.code == 404:
                return {}
            if 500 <= e.code < 600:
                time.sleep(2 ** attempt)
                continue
            return None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(2 ** attempt)
    return None


def zkb_window_prices(data: dict, dates: list[str]):
    """Pick a price per window date from a zKB price map.

    Uses the daily value when present, else ``currentPrice`` (zKB's daily
    history is often stale for capitals). Returns ``None`` if nothing is usable.
    """
    if not data:
        return None
    current = None
    raw = data.get("currentPrice")
    if raw is not None:
        try:
            current = float(raw)
        except (TypeError, ValueError):
            current = None
    picked: dict[str, float] = {}
    for date in dates:
        value = data.get(date)
        if isinstance(value, (int, float)):
            picked[date] = float(value)
        elif current is not None:
            picked[date] = current
    return picked or None


def fetch_history(region: int, tid: int, gate: RateGate, ua: str, retries: int = 4):
    """Fetch a type's market history, returning the parsed rows (or None)."""
    url = ESI_HISTORY.format(region=region, tid=tid)
    for attempt in range(retries):
        gate.acquire()
        req = urllib.request.Request(
            url, headers={"User-Agent": ua, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                gate.note_headers(resp.headers)
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            gate.note_headers(e.headers)
            if e.code in (420, 429):
                retry_after = e.headers.get("Retry-After")
                gate.pause(float(retry_after) if retry_after else 5.0)
                continue
            if e.code == 404:
                return []  # no market history for this type
            if 500 <= e.code < 600:
                time.sleep(2 ** attempt)
                continue
            return None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(2 ** attempt)
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--region", type=int, default=THE_FORGE_REGION_ID,
                    help="ESI region id for market history (default: The Forge).")
    ap.add_argument("--all-window", action="store_true",
                    help="Price every item across the whole kill window "
                         "(default: only the latest two days).")
    ap.add_argument("--workers", type=int, default=10,
                    help="Concurrent fetch threads (default: 10).")
    ap.add_argument("--rate", type=float, default=6.0,
                    help="Target requests per second across all threads "
                         "(default: 6).")
    ap.add_argument("--min-error-remain", type=int, default=10,
                    help="Pause when X-ESI-Error-Limit-Remain drops to this "
                         "(default: 10).")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT,
                    help="Output JSON path (default: public/data/market_prices.json).")
    ap.add_argument("--progress", action="store_true",
                    help="Print a simple progress line as fetches complete.")
    args = ap.parse_args()

    index = load_index()
    dates: list[str] = list(index.get("dates", []))
    if len(dates) < 1:
        sys.exit("error: kill index has no dates.")
    window = set(dates)

    type_ids = sorted(collect_type_ids(dates, args.all_window))
    if not type_ids:
        sys.exit("error: no item type ids found in the kill window.")

    # Capital ships are priced from zKillboard rather than ESI.
    capital_ids = load_capital_ship_ids()
    cap_in_scope = capital_ids & set(type_ids)
    print(f"pricing {len(type_ids)} types "
          f"({len(cap_in_scope)} capital ships via zKillboard, rest via ESI).")

    # The full User-Agent (with contact) comes from the environment so it isn't
    # published in the repo. See scripts/esi_env.py.
    ua = user_agent()
    gate = RateGate(min_interval=1.0 / max(args.rate, 0.1),
                    min_error_remain=args.min_error_remain)
    prices: dict[str, dict[str, float]] = {}
    done = 0
    lock = threading.Lock()
    total = len(type_ids)

    def work(tid: int):
        nonlocal done
        if tid in capital_ids:
            data = fetch_zkb_prices(tid, gate, ua)
            result = zkb_window_prices(data, dates) if data is not None else None
        else:
            rows = fetch_history(args.region, tid, gate, ua)
            result = None
            if rows:
                picked = {
                    r["date"]: r["average"]
                    for r in rows
                    if r.get("date") in window and "average" in r
                }
                if picked:
                    result = picked
        with lock:
            done += 1
            if result is not None:
                prices[str(tid)] = result
            if args.progress and (done % 50 == 0 or done == total):
                print(f"\r  priced {done}/{total} types "
                      f"({len(prices)} with a price)", end="", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(work, type_ids))
    if args.progress:
        print(file=sys.stderr)

    payload = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "region": args.region,
        "from": dates[0],
        "to": dates[-1],
        "dates": dates,
        # typeID -> { date -> average price }
        "prices": {tid: prices[tid] for tid in sorted(prices, key=int)},
    }

    # Idempotent write: skip if only the timestamp would change.
    args.out.parent.mkdir(parents=True, exist_ok=True)
    if args.out.exists():
        try:
            old = json.loads(args.out.read_text(encoding="utf-8"))
            old.pop("generated", None)
            new = dict(payload)
            new.pop("generated", None)
            if old == new:
                print(f"unchanged: {args.out} ({len(prices)} priced types)")
                return
        except (json.JSONDecodeError, OSError):
            pass

    args.out.write_text(
        json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    print(f"wrote {args.out}: {len(prices)}/{total} types priced "
          f"for {dates[0]}..{dates[-1]} (region {args.region}).")


if __name__ == "__main__":
    main()
