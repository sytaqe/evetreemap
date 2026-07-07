# SPDX-License-Identifier: CC0-1.0
# This file is released into the public domain under the CC0 1.0 Universal license.
"""Aggregate destroyed/dropped item quantities from recent killmails.

Pipeline (one day at a time):

1. Read zKillboard's per-day history file (killmailID -> hash) for each of the
   last N days that have data.
2. For every killmail, fetch the full killmail from ESI and tally each item's
   ``quantity_destroyed`` and ``quantity_dropped`` by ``item_type_id`` (items
   nested inside containers are counted recursively). The victim's hull
   (``ship_type_id``) is always counted as one destroyed unit of that type.
3. Write **one JSON file per day** to ``public/data/kill_stats/<YYYY-MM-DD>.json``
   (each holding that day's per-item ``destroyed``/``dropped`` totals), then
   rebuild ``public/data/kill_stats/index.json`` listing the available days.

Aggregation is **incremental**: only the running per-day aggregate and the list
of already-counted killmail ids are kept. On each run, killmails whose id is
already in that day's list are skipped; new ones are fetched and added to the
totals. Full killmails are never cached — the aggregate is committed to git and
the id list is the only thing cached across runs (persist it via ``actions/cache``
in CI). If a day's id list is missing, that day is rebuilt from scratch.

Because each day is written independently, a rerun can refresh a single day
(e.g. ``--days 1``) without recomputing the rest, and the index still lists
every day file present in the directory. ``--max-per-day`` caps the work for
quick sampling.

By default the run stops after ``--time-limit-minutes`` (350) so it fits inside
GitHub Actions' 6-hour job cap: on the deadline it cancels the pending fetches,
saves the partial aggregate (and cached ids) and exits cleanly, so the next run
resumes from where it left off. Pass ``--no-time-limit`` to process to
completion instead.

Usage:
    python scripts/build_kill_stats.py                 # full last 7 days (<=350 min)
    python scripts/build_kill_stats.py --max-per-day 150   # quick sample
    python scripts/build_kill_stats.py --days 1            # refresh latest day
    python scripts/build_kill_stats.py --day 2026-07-03   # (re)aggregate one day
    python scripts/build_kill_stats.py --no-time-limit     # run to completion
"""

from __future__ import annotations

import argparse
import datetime as dt
import itertools
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
from pathlib import Path

from esi_env import user_agent

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT_DIR = REPO_ROOT / "public" / "data" / "kill_stats"
DEFAULT_CACHE = REPO_ROOT / ".cache" / "processed_ids"

# One JSON file per calendar day is written under the output directory, plus an
# index the viewer reads to discover which days are available.
DAY_FILE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.json$")

ZKB_TOTALS = "https://r2z2.zkillboard.com/history/totals.json"
ZKB_HISTORY = "https://r2z2.zkillboard.com/history/{day}.json"
ESI_KILLMAIL = "https://esi.evetech.net/latest/killmails/{kid}/{khash}/"


def parse_ratelimit_limit(value: str):
    """Parse an ``X-Ratelimit-Limit`` value like ``3000/15m`` -> (3000, 900.0)."""
    try:
        tokens_s, window_s = value.split("/", 1)
        tokens = int(tokens_s)
    except (ValueError, AttributeError):
        return None
    window_s = window_s.strip().lower()
    unit = {"s": 1, "m": 60, "h": 3600}.get(window_s[-1:])
    try:
        seconds = int(window_s[:-1]) * unit if unit else int(window_s)
    except ValueError:
        return None
    return tokens, float(seconds)


def retry_after_seconds(headers, default: float) -> float:
    """Read a ``Retry-After`` header (seconds), falling back to `default`."""
    try:
        return float(int(headers.get("Retry-After")))
    except (TypeError, ValueError, AttributeError):
        return default


class EsiRateGate:
    """Coordinates all worker threads against ESI's rate and error limits.

    Handles both ESI limiters:

    * **Rate limit** (new): every response carries ``X-Ratelimit-Limit``
      (``<max>/<window>``) and ``X-Ratelimit-Remaining``, and a ``429`` +
      ``Retry-After`` is returned when exceeded. We derive a sustainable request
      interval from the limit and pace *all* threads to it, so 429s — which cost
      5 tokens each and only dig the hole deeper — are avoided proactively.
    * **Error limit** (old): ``X-ESI-Error-Limit-Remain`` / ``-Reset`` and a
      ``420`` when exceeded.

    A shared cooldown pauses every thread together (429/420/near-empty budget),
    while request pacing spreads the remaining requests over time.
    """

    TOKENS_PER_OK = 2  # ESI: a 2xx response costs 2 rate-limit tokens

    def __init__(self, min_remain: int = 10, safety: float = 0.8,
                 default_interval: float = 0.1, fallback_wait: float = 60.0):
        self._lock = threading.Lock()
        self._resume_at = 0.0   # hard cooldown end (monotonic); 0 = none
        self._next_slot = 0.0   # next allowed request start (pacing)
        self._interval = default_interval
        self.min_remain = min_remain
        self.safety = safety
        self.fallback_wait = fallback_wait

    def acquire(self) -> None:
        """Block until this thread may start a request (cooldown, then pacing)."""
        while True:  # 1. wait out any hard cooldown
            with self._lock:
                delay = self._resume_at - time.monotonic()
            if delay <= 0:
                break
            time.sleep(min(delay, 5.0))
        with self._lock:  # 2. reserve the next pacing slot
            start = max(time.monotonic(), self._next_slot)
            self._next_slot = start + self._interval
        wait = start - time.monotonic()
        if wait > 0:
            time.sleep(wait)

    def _pause(self, seconds: float) -> None:
        if seconds <= 0:
            return
        with self._lock:
            self._resume_at = max(self._resume_at, time.monotonic() + seconds)

    def observe(self, headers) -> None:
        """Read limit headers on every response; pace and cool down as needed."""
        if not headers:
            return
        parsed = parse_ratelimit_limit(headers.get("X-Ratelimit-Limit", ""))
        if parsed:
            max_tokens, window = parsed
            rps = (max_tokens / window) / self.TOKENS_PER_OK * self.safety
            if rps > 0:
                with self._lock:
                    self._interval = 1.0 / rps
        remaining = headers.get("X-Ratelimit-Remaining")
        try:
            if remaining is not None and int(remaining) <= self.min_remain:
                self._pause(5.0)  # near empty: brief cool-down to let it refill
        except ValueError:
            pass
        er = headers.get("X-ESI-Error-Limit-Remain")
        et = headers.get("X-ESI-Error-Limit-Reset")
        try:
            if er is not None and int(er) <= self.min_remain:
                self._pause(int(et) + 1)
        except (TypeError, ValueError):
            pass

    def rate_limited(self, headers) -> float:
        """Handle a 429: pause all threads for Retry-After; returns the delay."""
        seconds = retry_after_seconds(headers, self.fallback_wait)
        self._pause(seconds)
        return seconds

    def error_limited(self, headers) -> float:
        """Handle a 420: pause all threads for the error-limit reset window."""
        reset = headers.get("X-ESI-Error-Limit-Reset") if headers else None
        try:
            seconds = int(reset) + 1.0
        except (TypeError, ValueError):
            seconds = self.fallback_wait
        self._pause(seconds)
        return seconds


def http_get(
    url: str, ua: str, retries: int = 4, limiter: "EsiRateGate | None" = None
) -> bytes:
    """GET a URL with a descriptive User-Agent, honouring ESI's limits.

    When `limiter` is supplied, threads pace themselves to ESI's rate limit and
    pause together on a 429 (Retry-After) or 420. 429/420 waits do not consume
    the transient-error retry budget; 5xx and connection errors back off with it.
    """
    last: Exception | None = None
    attempt = 0        # transient (5xx / connection) failures
    limit_waits = 0    # rate/error-limit waits (capped separately)
    while True:
        if limiter is not None:
            limiter.acquire()
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": ua, "Accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=90) as resp:
                body = resp.read()
                if limiter is not None:
                    limiter.observe(resp.headers)
                return body
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 420):
                # Rate-limited (429) or error-limited (420): pause all threads.
                if limiter is not None:
                    (limiter.rate_limited if e.code == 429
                     else limiter.error_limited)(e.headers)
                else:
                    time.sleep(retry_after_seconds(e.headers, 60.0))
                limit_waits += 1
                if limit_waits > 40:
                    raise
                continue
            if e.code in (500, 502, 503, 504):
                if limiter is not None:
                    limiter.observe(e.headers)  # 5xx cost 0 tokens but note reset
                attempt += 1
                if attempt >= retries:
                    raise
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            attempt += 1
            if attempt >= retries:
                raise RuntimeError(f"GET failed after {retries} tries: {url} ({last})")
            time.sleep(2 ** attempt)


def tally_items(items, destroyed, dropped) -> None:
    """Recursively add each item's destroyed/dropped quantity to the totals."""
    for it in items:
        tid = it.get("item_type_id")
        if tid is None:
            continue
        if "quantity_destroyed" in it:
            destroyed[tid] += it["quantity_destroyed"]
        if "quantity_dropped" in it:
            dropped[tid] += it["quantity_dropped"]
        nested = it.get("items")
        if nested:
            tally_items(nested, destroyed, dropped)


def fetch_killmail(
    kid: str, khash: str, ua: str, limiter: EsiRateGate
) -> dict | None:
    """Fetch one killmail from ESI and return its parsed JSON (no caching).

    Killmails are aggregated on the fly and discarded; only the aggregate and
    the list of processed ids are persisted (see load/save helpers below).
    """
    try:
        body = http_get(ESI_KILLMAIL.format(kid=kid, khash=khash), ua, limiter=limiter)
    except Exception as e:
        print(f"  ! killmail {kid} failed: {e}", file=sys.stderr)
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def load_day_aggregate(day_file: Path):
    """Rebuild (destroyed, dropped) counters from an existing day file, or None."""
    if not day_file.exists():
        return None
    try:
        data = json.loads(day_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    destroyed: dict[int, int] = defaultdict(int)
    dropped: dict[int, int] = defaultdict(int)
    for tid, v in data.get("items", {}).items():
        destroyed[int(tid)] = v.get("destroyed", 0)
        dropped[int(tid)] = v.get("dropped", 0)
    return destroyed, dropped


# Killmail ids are near-sequential, so a day's ids share only a handful of
# high parts (id // 10000). Storing them grouped as { "<id//10000>": [id % 10000,
# …] } writes each high part once and each id as its low 4 digits, roughly
# halving the cache file vs. a flat list of full ids.
ID_SPLIT = 10000


def load_processed_ids(ids_file: Path) -> "set[int] | None":
    """Return the set of killmail ids already counted for a day, or None."""
    if not ids_file.exists():
        return None
    try:
        data = json.loads(ids_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    raw = data.get("ids")
    if isinstance(raw, dict):  # grouped { high: [low, …] } format
        return {int(hi) * ID_SPLIT + lo for hi, lows in raw.items() for lo in lows}
    return set(raw or [])  # backward-compatible flat list of full ids


def save_processed_ids(ids_file: Path, iso: str, ids: "set[int]") -> None:
    """Persist the processed-id list (the only thing cached across runs)."""
    ids_file.parent.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[int]] = defaultdict(list)
    for i in sorted(ids):
        groups[str(i // ID_SPLIT)].append(i % ID_SPLIT)
    grouped = {hi: groups[hi] for hi in sorted(groups, key=int)}
    payload = {"date": iso, "count": len(ids), "ids": grouped}
    with ids_file.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))


def write_json_if_changed(path: Path, payload: dict, ignore=("generated",)) -> bool:
    """Write `payload` only if it differs from the existing file.

    Ignores volatile keys (e.g. ``generated``) so a no-op run leaves committed
    files — and their timestamps — untouched, keeping git/CI diffs clean.
    Returns True if the file was (re)written.
    """
    drop = lambda d: {k: v for k, v in d.items() if k not in ignore}
    if path.exists():
        try:
            if drop(json.loads(path.read_text(encoding="utf-8"))) == drop(payload):
                return False
        except json.JSONDecodeError:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    return True


def available_days(end: dt.date | None, days: int, ua: str) -> list[str]:
    """Return the YYYYMMDD strings for the last `days` days that have data."""
    totals = json.loads(http_get(ZKB_TOTALS, ua))
    present = sorted(totals.keys())
    if not present:
        sys.exit("error: zKillboard totals returned no days")
    end_key = end.strftime("%Y%m%d") if end else present[-1]
    if end_key not in totals:
        sys.exit(f"error: no zKillboard history for {end_key}")
    idx = present.index(end_key)
    chosen = present[max(0, idx - days + 1) : idx + 1]
    return chosen


def render_progress(prefix: str, done: int, total: int, width: int = 30) -> None:
    """Draw an in-place CLI progress bar (call repeatedly, same line)."""
    frac = done / total if total else 1.0
    filled = round(width * frac)
    bar = "#" * filled + "-" * (width - filled)
    print(f"\r{prefix} [{bar}] {done}/{total} ({frac * 100:3.0f}%)",
          end="", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=7, help="Number of days")
    parser.add_argument("--end", help="End day YYYYMMDD (default: latest with data)")
    parser.add_argument("--day", help="Process only this single day "
                        "(YYYY-MM-DD or YYYYMMDD); overrides --days/--end")
    parser.add_argument("--max-per-day", type=int, default=0,
                        help="Cap killmails processed per day (0 = all)")
    parser.add_argument("--sample", choices=["strided", "head"], default="strided",
                        help="How --max-per-day samples a day: evenly spaced "
                             "across the day (default) or the earliest N")
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--time-limit-minutes", type=float, default=350,
                        help="Stop after this many minutes, save what has been "
                             "processed, and exit, leaving GitHub Actions' 6h "
                             "job cap some headroom (default: 350). A partial run "
                             "is resumable: the next run continues from the "
                             "cached ids.")
    parser.add_argument("--no-time-limit", action="store_true",
                        help="Disable the time limit and process to completion "
                             "(default: the time limit is enforced).")
    parser.add_argument("--progress", action="store_true",
                        help="Show a CLI progress bar while processing each day")
    parser.add_argument("--min-error-remain", type=int, default=10,
                        help="Pause all threads when ESI's error/rate budget "
                             "drops to this many remaining")
    parser.add_argument("--rate-safety", type=float, default=0.8,
                        help="Fraction of ESI's rate limit to target when pacing "
                             "requests (lower = gentler)")
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR,
                        help="Directory for per-day JSON files and index.json")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE,
                        help="Directory for per-day processed-id lists (cache)")
    args = parser.parse_args()

    # The full User-Agent (with contact) comes from the environment so it isn't
    # published in the repo. See scripts/esi_env.py.
    ua = user_agent()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    limiter = EsiRateGate(min_remain=args.min_error_remain, safety=args.rate_safety)

    if args.day:
        # Single-day mode: (re)aggregate just this one day, regardless of --days.
        try:
            one = dt.datetime.strptime(args.day.replace("-", ""), "%Y%m%d").date()
        except ValueError:
            sys.exit(f"error: --day must be YYYY-MM-DD or YYYYMMDD, got {args.day!r}")
        day_keys = available_days(one, 1, ua)
    else:
        end = dt.datetime.strptime(args.end, "%Y%m%d").date() if args.end else None
        day_keys = available_days(end, args.days, ua)
    print(f"Processing {len(day_keys)} day(s): {day_keys[0]}..{day_keys[-1]}")

    # Optional wall-clock budget: when reached we stop fetching, save the partial
    # aggregate (resumable from the cached ids) and exit cleanly.
    deadline = (
        None if args.no_time_limit
        else time.monotonic() + args.time_limit_minutes * 60
    )
    if deadline is not None:
        print(f"Time limit: {args.time_limit_minutes:g} min "
              "(pass --no-time-limit to disable)")
    hit_time_limit = False

    to_iso = lambda k: f"{k[:4]}-{k[4:6]}-{k[6:]}"
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    for day in day_keys:
        if deadline is not None and time.monotonic() >= deadline:
            hit_time_limit = True
            print(f"  time limit reached - stopping before {to_iso(day)}")
            break

        iso = to_iso(day)
        day_file = args.out_dir / f"{iso}.json"
        ids_file = args.cache_dir / f"{iso}.json"

        history = json.loads(http_get(ZKB_HISTORY.format(day=day), ua))
        pairs = list(history.items())
        if 0 < args.max_per_day < len(pairs):
            if args.sample == "strided":
                # Evenly spaced across the whole day rather than the earliest N,
                # so the sample better represents the full day's activity.
                stride = len(pairs) / args.max_per_day
                pairs = [pairs[int(i * stride)] for i in range(args.max_per_day)]
            else:  # "head": the earliest N killmails of the day
                pairs = pairs[: args.max_per_day]

        # Incremental update: reuse the committed aggregate and the cached id
        # list only when BOTH are present (so ids stay consistent with totals);
        # otherwise rebuild the day from scratch.
        cached_ids = load_processed_ids(ids_file)
        existing = load_day_aggregate(day_file)
        if cached_ids is not None and existing is not None:
            destroyed, dropped = existing
            ids = cached_ids
        else:
            destroyed = defaultdict(int)
            dropped = defaultdict(int)
            ids = set()

        # Only fetch killmails we have not already counted into this day.
        todo = [(kid, kh) for kid, kh in pairs if int(kid) not in ids]
        print(f"  {day}: {len(todo)} new / {len(pairs)} killmails "
              f"({len(ids)} already counted, history {len(history)})")

        failed = 0
        new_count = 0
        total = len(todo)
        step = max(1, total // 100)  # throttle redraws to ~100 updates
        # Submit explicitly (rather than pool.map) so that, on the deadline, we
        # can cancel the still-queued fetches and exit without waiting for them.
        pool = ThreadPoolExecutor(max_workers=args.workers)
        try:
            futures = {
                pool.submit(fetch_killmail, kid, kh, ua, limiter): kid
                for kid, kh in todo
            }
            done = 0
            for fut in as_completed(futures):
                done += 1
                try:
                    km = fut.result()
                except CancelledError:
                    continue
                if km is None:
                    failed += 1
                else:
                    victim = km.get("victim", {})
                    # The victim's hull is always destroyed — count it once.
                    ship = victim.get("ship_type_id")
                    if ship is not None:
                        destroyed[ship] += 1
                    tally_items(victim.get("items", []), destroyed, dropped)
                    ids.add(int(futures[fut]))
                    new_count += 1
                if args.progress and (done % step == 0 or done == total):
                    render_progress(f"    {iso}", done, total)
                if deadline is not None and time.monotonic() >= deadline:
                    hit_time_limit = True
                    break
        finally:
            # Cancel queued fetches; don't wait on the few already in flight.
            pool.shutdown(wait=False, cancel_futures=True)
        if args.progress and total > 0:
            print()  # move off the progress-bar line

        # Commit the aggregate to git; cache only the processed-id list.
        type_ids = sorted(set(destroyed) | set(dropped))
        day_payload = {
            "date": iso,
            "generated": now,
            "source": "zKillboard history + ESI killmails",
            "region": "all",
            "killmails_processed": len(ids),
            "killmails_failed": failed,
            "items": {
                str(tid): {"destroyed": destroyed.get(tid, 0),
                           "dropped": dropped.get(tid, 0)}
                for tid in type_ids
            },
        }
        wrote = write_json_if_changed(day_file, day_payload)
        # Refresh the id cache when it is stale (new ids) or missing.
        if new_count > 0 or cached_ids is None:
            save_processed_ids(ids_file, iso, ids)
        state = "wrote" if wrote else "unchanged"
        print(f"    {state} {day_file.name} (+{new_count} new, {len(ids)} total, "
              f"{failed} failed, {len(type_ids)} types)")

        if hit_time_limit:
            print(f"  time limit reached during {iso} - saved partial progress, "
                  "stopping (rerun to continue).")
            break

    # Rebuild the index from every day file present in the directory so that
    # incremental runs (e.g. --days 1) keep older days discoverable.
    dates = sorted(
        f.stem for f in args.out_dir.glob("*.json") if DAY_FILE_RE.match(f.name)
    )
    index = {
        "generated": now,
        "source": "zKillboard history + ESI killmails",
        "region": "all",
        "dates": dates,
    }
    index_file = args.out_dir / "index.json"
    state = "wrote" if write_json_if_changed(index_file, index) else "unchanged"
    print(f"{state} {index_file} ({len(dates)} day(s): {dates[0]}..{dates[-1]})")


if __name__ == "__main__":
    main()
