<!--
SPDX-License-Identifier: CC0-1.0
This file is released into the public domain under the CC0 1.0 Universal license.
-->

# EVE Treemap

An interactive treemap visualization of EVE Online activity, built as a fully
static single-page application and deployed to GitHub Pages. All data is
prepared ahead of time and served as static JSON — there is no backend server.

> This README is the full application specification. See [`SPEC.md`](SPEC.md)
> for the detailed UI/feature specification (columns, tag labels, ship icon
> overlays, SDE classification rules, row backgrounds), and `RELEASE.md` (local
> only, gitignored) for the release procedure.

## Overview

EVE Treemap visualizes EVE Online item circulation and consumption, derived
from the game's Static Data Export (SDE) and public ESI data.

**Current view — Market Browser:** a two-pane browser (modeled on
[evemarketbrowser.com](https://evemarketbrowser.com/)) with a market-group item
tree on the left and an item detail pane on the right. The detail pane shows the
selected item's image and name, and a line chart of its daily average price and
traded volume in The Forge region (from public ESI market-history data) with
daily destroyed/dropped quantities from recent killmails overlaid.

**Tree Map view:** a Finviz-style treemap where each item's tile area is its
latest-day ISK value — `quantity × average price` in The Forge — and its color
is the day-over-day change (green up, red down), with `{total} ({change})` shown
on the tile. Two variants pick the quantity: **Tree Map (All)** uses
`destroyed + dropped` and **Tree Map (Destroyed)** uses `destroyed` only. Tiles
are grouped by the `market_tree.json` group hierarchy (excluding the Apparel,
Blueprints & Reactions, Personalization, Ship SKINs, and Skills top-level
groups), drawn three levels deep at a time: a group three levels below the
current view is a single tile you drill into, and a breadcrumb walks back up.
Links at
the top of the UI switch between the Market Browser and the two Tree Maps.

See [`SPEC.md`](SPEC.md) for the detailed UI specification of both views.

## Architecture

- **Frontend:** React + [Vite](https://vitejs.dev/), TypeScript.
- **Hosting:** GitHub Pages, fully static — no server-side runtime.
- **Data:** Application data is served as static JSON files under
  `public/data/`, generated from the SDE by the Python scripts below. The market
  tree (`public/data/market_tree.json`) is **committed** so the site deploys
  without needing the ~549&nbsp;MB SDE dump in CI; activity data generated later
  will follow the build-time convention.
- **Images:** Item icons/renders come from the public, key-less EVE image server
  (`https://images.evetech.net`) — no ESI authentication required.
- **Authentication (planned):** EVE SSO using the PKCE flow (client-side only).
  Access tokens are stored in browser cookies. No client secret is ever shipped.
- **Automation:** GitHub Actions build the site and deploy to GitHub Pages on
  push to `main`.

### Directory layout

```
.
├── public/
│   ├── data/
│   │   ├── market_tree.json    # Generated market-group item tree (committed)
│   │   ├── market_prices.json  # Per-day average prices for treemap tiles (committed)
│   │   └── kill_stats/         # Per-day destroyed/dropped files + index.json
│   └── vite.svg
├── scripts/
│   ├── build_market_tree.py    # Parses SDE marketGroups + types into the tree
│   ├── build_kill_stats.py     # Aggregates zKillboard + ESI killmail item totals
│   ├── build_market_prices.py  # Fetches ESI market history → per-day avg prices
│   ├── esi_env.py              # Reads the ESI User-Agent from ESI_USER_AGENT / .env
│   └── sde_latest_build.py     # Prints CCP's latest SDE build number
├── src/
│   ├── components/
│   │   ├── MarketTreeView.tsx  # Left pane: market group tree
│   │   ├── ItemDetail.tsx      # Right pane: selected item image + name
│   │   └── TreemapView.tsx     # Tree Map view: Finviz-style value treemap
│   ├── App.tsx                 # View switcher, layout + data loading
│   ├── eve.ts                  # EVE image server helpers
│   ├── treemap.ts              # Dependency-free squarified treemap layout
│   └── types.ts                # Market tree / kill / price data types
├── .github/workflows/        # Build/deploy to GitHub Pages
├── CLAUDE.md                 # Guide for Claude
├── README.md                 # This file — full application spec
└── SPEC.md                   # UI/feature specification
```

## Data

### Static Data Export (SDE)

The SDE is EVE Online's authoritative static data set (types, groups,
categories, blueprints, map data, and more). It is distributed as a large set
of JSONL files (one JSON object per line). This project consumes the JSONL SDE
dump (folder `eve-online-static-data-3409592-jsonl/` in local development).

- The SDE dump itself is **gitignored** (~549&nbsp;MB). For local development it
  is expected at `eve-online-static-data-3409592-jsonl/`.
- The dump includes a `_sde.jsonl` manifest identifying the build, e.g.:

  ```json
  {"_key": "sde", "buildNumber": 3409592, "releaseDate": "2026-06-25T12:00:48Z"}
  ```

- Records are keyed by `_key` and carry localized `name` maps
  (`en`, `de`, `fr`, `ja`, ...). The app uses the **English** (`en`) names only;
  see Conventions below.

  ```json
  {"_key": 1, "name": {"en": "Owner", "ja": "所有者"}, "published": false}
  ```

### Market tree

`scripts/build_market_tree.py` parses `marketGroups.jsonl` and `types.jsonl`
into `public/data/market_tree.json` — the nested market-group tree consumed by
the Market Browser. Only `published` types with a `marketGroupID` are included,
empty branches are pruned, and entries are sorted by English name. See
[`SPEC.md`](SPEC.md) §4.1 for the exact output schema.

To refresh it when a new SDE ships without downloading the ~549&nbsp;MB dump
locally, run the **Regenerate market tree** workflow
(`.github/workflows/market-tree.yml`, manual): it fetches the official EVE SDE
(JSONL) from CCP, rebuilds `market_tree.json`, and commits any change to `main`.
It first compares the latest SDE build against the one `market_tree.json` was
built from and **skips the download entirely when unchanged** (a pinned `build`
input forces a rebuild).

### Market prices

`scripts/build_market_prices.py` precomputes the daily average price used to
size the Tree Map tiles. Fetching a price for every item in the kill window at
view time would mean ~1000 ESI calls in the browser, so — like the market tree
and kill stats — it is generated out of band and committed as
`public/data/market_prices.json`. For each item that appears in the last two
kill-stats days (or the whole window with `--all-window`) it fetches ESI
`GET /markets/{region}/history/` (The Forge by default) and keeps the `average`
for each window date, emitting `{ generated, region, from, to, dates, prices }`
where `prices` maps `"<typeID>"` to `{ "<YYYY-MM-DD>": average }`. Writes are
idempotent (ignoring the timestamp). Rerun it whenever the kill window advances.

**Capital ships** (types under the *Ships → Capital Ships* market group, read
from `market_tree.json`) are priced from
[zKillboard's Prices API](https://github.com/zKillboard/zKillboard/wiki/API-(Prices))
(`GET https://zkillboard.com/api/prices/{id}/`) instead of ESI, since they trade
thinly or not at all on the Forge market. zKB's daily history can be stale for
capitals, so any window date it lacks falls back to its `currentPrice`.

```bash
npm run prices                                    # latest+prev day items (+progress)
python scripts/build_market_prices.py             # same, no progress bar
python scripts/build_market_prices.py --all-window   # price the whole kill window
```

To refresh it in CI, run the **Regenerate market prices** workflow
(`.github/workflows/market-prices.yml`, manual): it reruns the script against the
committed kill-stats window and market tree and commits any change to `main`.
Run it after the kill-stats window advances.

### Kill statistics

`scripts/build_kill_stats.py` aggregates destroyed/dropped item quantities from
recent killmails into **one file per day** under `public/data/kill_stats/`
(`<YYYY-MM-DD>.json`) plus an `index.json`. For each of the last _N_ days
(default 7) it reads zKillboard's history file (killmail id + hash) and fetches
each killmail from the public ESI API, tallying `quantity_destroyed` and
`quantity_dropped` per item type. Each victim's hull (`ship_type_id`) is also
counted as one destroyed unit of that ship type. Because each day is written
independently, a rerun can refresh a single day without recomputing the rest.

Aggregation is **incremental**: full killmails are never cached — the script
keeps the running per-day aggregate (committed to git) plus a list of
already-counted killmail ids (cached under `.cache/processed_ids/`, gitignored).
Each run fetches only killmails not yet in that day's list and adds them to the
totals, so re-runs are cheap. In CI, persist the id lists with `actions/cache`.

ESI rate-limits the killmail endpoint (≈2 requests/second), and the script paces
itself to it (respecting `X-Ratelimit-*` / `429` `Retry-After`; tune with
`--rate-safety`). So a full first run still processes 100k+ killmails at that
ceiling — many hours — and is too heavy for the per-push Pages build. Run it out
of band and commit the refreshed JSON. `--max-per-day` caps the work for
sampling, and `--sample` picks those killmails evenly spaced across the day
(`strided`, default) or as the earliest N (`head`). See [`SPEC.md`](SPEC.md) §4.2.

To stay within GitHub Actions' 6-hour job limit, the script stops after
`--time-limit-minutes` (default **350**): on the deadline it cancels the pending
fetches, saves the partial per-day aggregate (and its cached id list) and exits
cleanly, so a rerun **resumes** from where it stopped. Pass `--no-time-limit`
to run to completion (e.g. locally, with no CI cap).

```bash
npm run killstats                                   # full last 7 days (+progress bar)
python scripts/build_kill_stats.py                  # same, no progress bar
python scripts/build_kill_stats.py --max-per-day 150   # quick sample
python scripts/build_kill_stats.py --days 1            # refresh latest day only
python scripts/build_kill_stats.py --no-time-limit     # ignore the 350-min cap
```

Pass `--progress` to show a per-day CLI progress bar (disabled by default; the
`npm run killstats` script enables it). Writes are idempotent — a run that adds
no new killmails leaves the committed files (and their timestamps) untouched.

### Kill statistics workflow (manual)

`.github/workflows/kill-stats.yml` runs the aggregation on demand
(`workflow_dispatch`, with `days` / `max_per_day` inputs), restores the
processed-id lists via `actions/cache`, and commits any changes to `main`. It is
**manual only** and defaults to a sampled run (`--max-per-day 500`). When it
commits new data it then dispatches the Pages deploy workflow explicitly with
`gh workflow run deploy.yml` (a `GITHUB_TOKEN` push does not trigger it), so the
site is republished automatically. This needs the `actions: write` permission,
already set in the workflow.

If the change touches the **latest day** (a new day rolled over, or the most
recent day's aggregate changed), it **skips the direct deploy** and instead
dispatches `market-prices.yml`, which regenerates the treemap prices — which
track the latest two days — and deploys itself. That ordering avoids publishing
new kill data against stale prices (a new day would otherwise briefly leave the
treemap without prices for that date). `kill-stats-day.yml` chains market-prices
the same way (only when the day it refreshed is the latest one).

`.github/workflows/kill-stats-day.yml` is the same, but for a **single day**: it
takes a required `day` input (`YYYY-MM-DD`) and runs `--day`, to (re)aggregate or
top up just that day. It shares the `actions/cache` id lists and the
`kill-stats` concurrency group with the multi-day workflow, and commits/deploys
the same way. Both pass the `ESI_USER_AGENT` secret through to the script.

## Getting started

### Prerequisites

- Node.js (LTS) and npm
- Python 3.x

### ESI User-Agent

The Python data scripts that call ESI/zKillboard
(`scripts/build_kill_stats.py`, `scripts/build_market_prices.py`) read the full
`User-Agent` — including a contact address, as ESI etiquette expects — from the
`ESI_USER_AGENT` environment variable, so no address is hard-coded in the repo.
For local runs, copy `.env.example` to `.env` (gitignored) and set your own:

```bash
cp .env.example .env      # then edit ESI_USER_AGENT=...
```

In CI, set a GitHub Actions **secret** named `ESI_USER_AGENT` (the kill-stats
workflow passes it through as an env var). The scripts exit with an error if it
is unset.

### Setup

```bash
# 1. Install frontend dependencies
npm install

# 2. (Re)generate the market tree from the local SDE dump.
#    Only needed if the SDE changed — market_tree.json is committed.
npm run data      # = python scripts/build_market_tree.py

# 3. Run the dev server (served under the /evetreemap/ base path)
npm run dev
```

### Build

```bash
npm run build      # Produces the static site in dist/
npm run preview    # Serves the production build locally
```

## Deployment

Pushing to the remote `main` branch triggers the GitHub Actions workflow
(`.github/workflows/deploy.yml`), which builds the Vite site and deploys it to
GitHub Pages; it can also be run manually via `workflow_dispatch`. The exact
release procedure is documented in `RELEASE.md`, which is kept local and
gitignored.

## Conventions

- All UI labels, messages, and user-facing text are in **English**.
- When a change affects the specification, update both `README.md` and
  [`SPEC.md`](SPEC.md) to match.
- Every source file begins with a CC0 1.0 Public Domain license header (see
  [`CLAUDE.md`](CLAUDE.md) for the exact text; use `#` comments for Python).

## License

Released into the public domain under the
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) license.

EVE Online and all related materials are property of
[CCP Games](https://www.ccpgames.com/). This is an unofficial, fan-made tool.
