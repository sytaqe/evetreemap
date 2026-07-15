<!--
SPDX-License-Identifier: CC0-1.0
This file is released into the public domain under the CC0 1.0 Universal license.
-->

# EVE Treemap — UI & Feature Specification

This document specifies the user-facing behavior of the application. Two views
are implemented — the **Market Browser** (§1) and the **Tree Map** (§2) — and a
link at the top of the UI switches between them. Data formats and pipelines are
in §4, and architecture & repository layout in §8; for setup and build/run
instructions, see [`README.md`](README.md).

> **Status:** Values marked `TBD` are placeholders owned by the project
> maintainer. Fill them in as the implementation is finalized, and keep this
> file and `README.md` in sync whenever the specification changes (per
> [`CLAUDE.md`](CLAUDE.md)).

All user-facing text in the application must be in **English**.

## 1. Market Browser (implemented)

A two-pane browser modeled on [evemarketbrowser.com](https://evemarketbrowser.com/).
The left pane is a market-group tree; the right pane shows details for the
selected item.

### 1.1 Layout

- **Left pane — market tree:** a scrollable, fixed-width column listing market
  groups hierarchically.
- **Right pane — item detail:** fills the remaining width and shows the
  currently selected item.
- **Header:** application title (“EVE Treemap”) and the view switcher — links
  for the two Tree Maps (§2) and, on the right, Market Browser. The current mode
  is reflected in the **URL hash** (`#treemap-all`, `#treemap-destroyed`,
  `#market`), so opening a link with that hash selects the mode; the hash follows
  tab clicks and back/forward, and an unknown or missing hash defaults to Tree
  Map (All). For the Tree Map views the current **drill path** is appended as the
  group ids below the view slug (e.g. `#treemap-all/4/1367` is Ships ▸ Cruisers),
  so a link opens the map already drilled to that group. Drilling in (or opening
  an item in the Market Browser) pushes a browser-history entry, so **Back** steps
  back up the drill path; top-level tab switches replace the current entry instead
  of piling up. A path segment that no longer names a live group is ignored.

### 1.2 Left pane — market group tree

- A sticky toolbar sits at the top of the pane with a **Collapse all** button
  that closes every open group. It is disabled when nothing is expanded.
- Groups are arranged by the SDE `parentGroupID` hierarchy; top-level groups
  (no parent) are the roots.
- Each group row has a disclosure caret and toggles open/closed on click.
  Groups start **collapsed**.
- Child content of an open group is rendered in this order: **child groups
  first, then item types**, each sorted alphabetically (case-insensitive) by
  English name.
- Each item (leaf) row shows a small 32px type icon and the item name. Clicking
  an item selects it and populates the right pane.
- The selected item row is visually highlighted.
- Empty branches are not shown: any group with no item types anywhere in its
  subtree is pruned at data-build time (see §4).

### 1.3 Right pane — item detail

For the selected item the pane shows a header (image + name + kill-count cards)
and a market-history chart with a daily destroyed/dropped overlay (§1.3.1).

| Field    | Source                                                        |
| -------- | ------------------------------------------------------------- |
| Image    | EVE image server, `types/{typeID}/icon` at 128px (see §5).    |
| Name     | English (`en`) name from the SDE.                             |
| Type ID  | The item's `_key` from `types.jsonl`.                         |

- **Kill-count cards** (right of the name, shown when kill data is loaded): two
  cards with the item's destroyed and dropped quantities — one for the **latest
  day** (labelled with its date) and one for the **last 7 days total**. Values
  come from `kill_stats` (§4.2); the recent total sums the last 7 daily entries
  (data may hold more days), and an item with no records shows zeros. Destroyed
  and dropped use the chart's colors (`--series-destroyed` / `--series-dropped`).
- When no item is selected, the pane shows an English prompt inviting the user
  to pick an item from the tree.
- **Planned additions (not yet implemented):** description and market group
  path.

#### 1.3.1 Market history chart (with kill overlay)

Below the header, a line chart shows the item's daily market history in **The
Forge** region (`region_id` 10000002, EVE's primary trade hub), with daily
destroyed/dropped quantities overlaid.

- **Market data source:** ESI `GET /markets/{region_id}/history/?type_id={typeID}`,
  a public, key-less, CORS-enabled endpoint (no authentication). Rows are sorted
  ascending by date.
- **Series and axes** (scales differ greatly, so up to three Y axes are used):
  - **Average price** (`average`, ISK) — left axis, accent color, line.
  - **Volume** (`volume`, units traded) — inner-right axis, volume color, line.
  - **Destroyed/day** and **Dropped/day** (units, from §4.2) — outer-right axis
    shared by both, drawn as one **stacked vertical bar per day** (destroyed at
    the bottom, dropped stacked on top), behind the price/volume lines. The axis
    spans the tallest destroyed + dropped daily total.
- **Kill overlay & window:** the per-day destroyed/dropped values come from the
  precomputed per-day files under `public/data/kill_stats/` (§4.2) — the index
  and each day file are loaded at startup and merged into a daily series. When
  present, the price history is **clipped to the kill window** (`from`..`to`) so
  the whole chart covers only that period — out-of-range days are hidden — and
  the kill points align to the price days by date. A note above the chart states
  the window and the number of sampled killmails the totals are drawn from
  (`killmails_processed`, summed over the window). The overlay is
  **optional**: if the kill index is absent the chart shows the full price
  history with no overlay. If the item has price history but none inside the
  window, a “no market history in the kill window” message is shown instead.
- **X axis:** date; up to six evenly spaced tick labels — `MM-DD` for short
  windows (≤31 days), `YYYY-MM` for longer spans.
- **Axis labels:** compact formatting (e.g. `1.2M`, `3.4k`).
- **Rendering:** a dependency-free SVG that fills the full available pane width
  at a fixed height — the `viewBox` width tracks the container's measured pixel
  width (via `ResizeObserver`) so the lines always span the whole pane. Colors
  come from CSS variables (`--accent`, `--series-volume`, `--series-destroyed`,
  `--series-dropped`).
- **Fetch states:** the pane shows an English message for _loading_, _error_
  (with the failure reason), and _empty_ (the item has no recorded history);
  otherwise it renders the chart. In-flight requests are aborted when the
  selection changes so a stale response cannot overwrite a newer one.

## 2. Tree Map (implemented)

A [Finviz](https://finviz.com/map.ashx)-style treemap that expresses each item's
recent ISK throughput as **area** and its day-over-day change as **color**. It
fills the whole body (no side tree) and is reached from the top view switcher,
which offers two variants that differ only in the sizing metric:
**Tree Map (All)** uses `destroyed + dropped`, and **Tree Map (Destroyed)** uses
`destroyed` only. They share the same hierarchy and drill position.

### 2.1 Tile value & color

- **Area (value):** for each item, the most recent kill-stats day's
  `quantity × average price` — the ISK value moved that day — where the quantity
  is `destroyed + dropped` (All) or `destroyed` only (Destroyed) per the chosen
  variant. The quantity comes from `kill_stats` (§4.2, all-region daily totals);
  the average price from `market_prices` (§4.3, The Forge). Items with no
  latest-day price or a zero value are omitted.
- **Color (change):** the same value is computed for the **previous** day and
  the change ratio `(latest − previous) / previous` drives the color — **green**
  when it rose, **red** when it fell, neutral near flat, with intensity scaling
  up to a ±40% move. An item with no previous-day value is labelled **NEW** and
  shown full green.
- **Value & change label:** the tile shows its total value and change together
  as `{total} ({change})` — e.g. `7.12B (+1.3%)`, `2.07B (−20.3%)`, or
  `276.50M (NEW)` — where the total is the compact ISK value and the change is
  the signed percent (or `NEW`).

### 2.2 Grouping & layout

- **Hierarchy:** items are grouped by the **full market-group tree** from
  `market_tree.json` (§4.1) — the same nested `marketGroups` structure used by
  the Market Browser (e.g. Ships ▸ Battleships ▸ Standard Battleships ▸ Caldari
  ▸ item), not a single flattened level. Each group's value/change aggregate all
  of its descendants; branches with no priced items are pruned.
- **Excluded groups:** whole top-level market groups that aren't item
  "consumption" of interest are hidden — **Apparel**, **Blueprints & Reactions**,
  **Personalization**, **Ship SKINs**, and **Skills** (matched by English name).
- **Depth-limited nesting:** only **three levels** below the current node are
  drawn, not the whole subtree. A direct child group becomes an expandable
  **section** (a framed box with a header strip) whose own children are packed
  inside it, nested one more level the same way; a group **three levels down** is
  drawn as a single **tile** rather than being expanded — you drill into it to go
  deeper. **Exception:** **faction groups** are never stopped at the cutoff —
  they always expand one level further so their ships/items stay visible. This
  covers every faction grouping in the market tree (matched by English name): the
  empire races (Amarr, Caldari, Gallente, Minmatar), the empire states/navies
  (Amarr Empire, Caldari State, Gallente Federation, Minmatar Republic, Amarr
  Navy, Caldari Navy, Ammatar Navy), and the pirate/special factions (ORE,
  Triglavian, EDENCOM, CONCORD, Sisters of EVE, Mordu's Legion, Angel Cartel,
  Angels, Blood Raiders, Guristas, Sansha's Nation, Serpentis).
  Items always draw as
  tiles at whatever level they appear. A [squarified][squarify] layout keeps
  tiles close to square. A subtree whose tiles would all be sub-pixel (nothing
  visible) is dropped **recursively**, so no empty group frames are drawn.
- **Group header:** each section box (large enough to fit one) shows the group
  name, its aggregate change percent (colored), and a representative descendant
  item icon; hovering shows the ISK value. Clicking a header **zooms into** that
  group.
- **Drill-down & breadcrumb:** clicking a section header or a group **tile**
  zooms in, showing that group's three levels filling the canvas. The toolbar
  breadcrumb lists the full path (`All groups ▸ <Group> ▸ <Subgroup> ▸ …`); each
  ancestor is a link that jumps back to that level, and **All groups** returns to
  the top. The drill position is reflected in the URL hash (§1.1), **preserved**
  when switching to the Market Browser and back, and steppable with browser
  Back/Forward.
- **Metric note:** the toolbar states the metric, the latest day, and the
  comparison day.

[squarify]: https://www.win.tue.nl/~vanwijk/stm.pdf

### 2.3 Tile contents

Each Item (and Item Group) rectangle shows, space permitting:

- the **item / group name**,
- the **`{total} ({change})`** label (§2.1),
- for **item** tiles large enough (i.e. once zoomed in), the **unit count** —
  the latest-day quantity that produced the value (`N unit(s)`),
- the **item icon** (`types/{typeID}/icon`, §5; a group uses its largest
  descendant item's icon).

The icon, text and spacing **scale with the tile size** (clamped to legible
bounds), so larger rectangles render larger content. Small tiles progressively
drop the unit count, then the icon, then the value/change label, then the name,
down to a bare colored rectangle; the full name, ISK value, units, and change
are always available via the tile's tooltip. A group tile carries a lighter inset border to
signal it is drillable. Clicking an **item** tile opens it in the Market Browser
(§1) with its detail and history; clicking a **group** tile zooms into it (§2.2).

### 2.4 Future additions (not yet implemented)

- Ship icon overlays / tag labels (New, Hot) from SDE classification.
- Alternative metrics (e.g. raw kill count) or grouping levels.
- A companion detail table.

## 3. SDE data classification rules

Records are keyed by `_key` and reference their parents by ID.

- **Market tree (implemented):** an item belongs to the market group named by
  its `types.jsonl` `marketGroupID`; groups nest via `marketGroups.jsonl`
  `parentGroupID`.
- **Type → Group (treemap, planned):** each `types.jsonl` record has a
  `groupID`; each `groups.jsonl` record has a `categoryID`.
- **Ships (treemap, planned):** identified by their SDE category/group (e.g. the
  “Ship” category); confirm the exact `categoryID`/`groupID` set used.
- **Published filter:** only include records where `published` is `true` (the
  SDE includes an unpublished `#System` set with `published: false`).
- **Names:** always use the `en` value from a record's localized `name` map.

## 4. Data pipelines

Both datasets below are precomputed into `public/data/`, not fetched at runtime.

### 4.1 Market tree

- `scripts/build_market_tree.py` reads `marketGroups.jsonl` and `types.jsonl`
  and emits a single nested JSON tree to `public/data/market_tree.json`. The
  input SDE is the official CCP JSONL export; the `market-tree.yml` workflow (§7)
  downloads it and regenerates the tree without keeping the dump in git.
- Only `published` types that have a `marketGroupID` are included.
- Groups whose subtree contains no types are pruned; groups and types are sorted
  alphabetically by English name.
- The payload is `{ "build": <SDE build number>, "roots": [ group … ] }`, where
  each group is `{ id, name, iconID, groups: [ … ], types: [ { id, name } ] }`.

### 4.2 Kill statistics

`scripts/build_kill_stats.py` aggregates destroyed/dropped item quantities from
recent killmails into per-day files under `public/data/kill_stats/`.

- **Days:** the last _N_ days (default 7) that have data, ending at the most
  recent available day per zKillboard's `history/totals.json`.
- **Per day:** read zKillboard's history file
  (`https://r2z2.zkillboard.com/history/{YYYYMMDD}.json`), a map of
  `killmailID → hash`.
- **Per killmail:** fetch ESI `GET /killmails/{id}/{hash}/` and tally each
  victim item's `quantity_destroyed` / `quantity_dropped` by `item_type_id`,
  recursing into items nested inside containers. The victim's hull
  (`ship_type_id`) is always counted as one destroyed unit of that ship type.
- **Incremental aggregation:** only the running aggregate and the set of
  already-counted killmail ids are kept — **full killmails are never cached**.
  For each day the script loads the committed aggregate plus a cached id list
  (`.cache/processed_ids/<YYYY-MM-DD>.json`), fetches only killmails whose id is
  not yet in the list, adds them to the totals, and appends their ids. So the
  **aggregate is committed to git** and the **id list is the only thing cached**
  across runs (persist it via `actions/cache` in CI). Both must be present to
  update incrementally; if a day's id list is missing the day is rebuilt from
  scratch. `--max-per-day` caps the killmails considered per day; `--sample`
  selects them **evenly spaced across the day** (`strided`, default) or as the
  earliest N (`head`).
  Because killmail ids are near-sequential, the id list is stored grouped by
  high part — `{ "<id // 10000>": [ id % 10000, … ] }` — which writes each id as
  its low four digits and roughly halves the cache file (a flat list of full ids
  is still accepted for backward compatibility).
- **Etiquette, rate & error limits:** requests carry a descriptive `User-Agent`
  read from the `ESI_USER_AGENT` env var (a `.env` file locally, a GitHub secret
  in CI) so the contact address isn't published in the repo; the script exits if
  it is unset.
  ESI killmail fetches run on a thread pool (`--workers`, default 10) that shares
  a **rate gate** honouring both of ESI's limiters:
  - **Rate limit:** the gate reads `X-Ratelimit-Limit` (e.g. `3600/15m` for the
    `killmail` group) and paces all threads to a sustainable interval
    (`--rate-safety`, default 0.8 = 80 % of the limit; a 2xx costs 2 tokens), so
    the `429`s the user would otherwise hit are avoided. On a `429` all threads
    pause for its `Retry-After`; when `X-Ratelimit-Remaining` nears zero they
    pause briefly to let tokens refill.
  - **Error limit:** on `X-ESI-Error-Limit-Remain` ≤ `--min-error-remain`
    (default 10) or a `420`, all threads pause for the reset window.
  - 5xx/connection failures retry with exponential backoff.

  The rate limit (≈2 req/s for killmails) is a hard ceiling, so a full 7-day
  run (100k+ killmails) takes many hours — far too heavy for the per-push Pages
  build. Run it out of band (sampled via `--max-per-day`) and commit the JSON.
- **Time budget:** by default the run stops after `--time-limit-minutes`
  (default **350**) so it fits inside GitHub Actions' 6-hour job cap. On the
  deadline it cancels the queued fetches, writes the partial per-day aggregate
  and its cached id list, and exits **cleanly** (so the workflow still commits)
  — a rerun **resumes** from the cached ids. `--no-time-limit` disables the cap
  and runs to completion.
- **Output — one file per day:** each processed day is written independently to
  `public/data/kill_stats/<YYYY-MM-DD>.json` as `{ date, generated, region,
  killmails_processed, killmails_failed, items }`, where `items` maps
  `"<typeID>"` to `{ "destroyed": N, "dropped": M }` for that day and
  `killmails_processed` is the cumulative count folded into the aggregate.
  Because each day is a separate file, a rerun can refresh one day without
  recomputing the rest — the latest day (`--days 1`) or any specific day
  (`--day YYYY-MM-DD`). Writes are **idempotent** — files whose content is
  unchanged (ignoring the `generated` timestamp) are left as-is, so a no-op run
  produces no git diff. Manual GitHub Actions workflows
  (`.github/workflows/kill-stats.yml`, and `kill-stats-day.yml` for a single day)
  run this incrementally and commit any changes to `main`.
- **Index:** after writing day files, `public/data/kill_stats/index.json` is
  rebuilt from every `<YYYY-MM-DD>.json` present in the directory:
  `{ generated, region, dates: [ … ] }`. The viewer reads the index, fetches
  each day file, and merges them into a daily series.

### 4.3 Market prices

`scripts/build_market_prices.py` precomputes the average prices that size the
Tree Map tiles (§2), emitting `public/data/market_prices.json`.

- **Items priced:** by default the union of item types in the latest two
  kill-stats days (`--all-window` prices every day in the window instead).
- **Source (most items):** ESI `GET /markets/{region}/history/?type_id={id}` —
  The Forge (`10000002`) by default. For each item the `average` is kept for
  every kill window date present in its history.
- **Source (capital ships):** types under the *Ships → Capital Ships* market
  group (read from `market_tree.json`) are priced from zKillboard's Prices API
  (`GET https://zkillboard.com/api/prices/{id}/`) instead — they barely trade on
  the Forge market. That endpoint returns `{ "<date>": price, …,
  "currentPrice": "…" }`; the daily value is used per window date, falling back
  to `currentPrice` where zKB's (often stale) daily history lacks that date. Both
  sources feed the same `prices` map, so the viewer is unchanged.
- **Etiquette:** requests carry a descriptive `User-Agent` (from the
  `ESI_USER_AGENT` env var, as in §4.2) and run on a thread pool paced to a
  target rate, backing off on ESI's error-limit headers / `420` / `429`; 5xx and
  connection errors retry with backoff.
- **Output:** `{ generated, region, from, to, dates, prices }`, where `prices`
  maps `"<typeID>"` to `{ "<YYYY-MM-DD>": average }`. Writes are **idempotent**
  (ignoring `generated`), so a no-op run produces no git diff. Rerun it whenever
  the kill window advances so the latest/previous day prices stay in sync.

## 5. Images & ESI

Imagery comes from the public, key-less EVE image server
(`https://images.evetech.net`), and market data from public ESI endpoints; no
ESI authentication is required for either:

- **Tree icons:** `types/{typeID}/icon?size=32`.
- **Detail image:** `types/{typeID}/icon?size=128`.
- **Market history:** `GET https://esi.evetech.net/latest/markets/{region_id}/history/?type_id={typeID}`
  (see §1.3.1). Also fetched **build-time** to precompute treemap prices (§4.3).
- **Killmails (build-time only):** zKillboard history + ESI
  `GET /killmails/{id}/{hash}/` (see §4.2).

## 6. Authentication (planned)

- Sign-in uses EVE SSO via the PKCE flow (client-side only).
- Signed-in vs. signed-out states and any gated features are TBD.
- Tokens are stored in browser cookies; no client secret is present in the app.

## 7. GitHub Actions workflows

Five workflows under `.github/workflows/`. Third-party actions are pinned to the
major-version tag below (auto-updates within the major); bump these when a new
major is released.

The four data workflows (`kill-stats*.yml`, `market-tree.yml`, `market-prices.yml`)
all commit to `main`, and a long run can overlap another's commit. Two guards keep
this from failing:

- They **check out the live tip of `main`** (`ref: main`), not the commit the run
  was pinned to at dispatch. A run queued behind another (shared concurrency
  group) would otherwise start from a stale base and, for kill-stats, re-aggregate
  the same day files divergently — an unmergeable conflict on the push rebase.
- Their push step **rebases onto the latest `main` and retries** (a few times), so
  a commit that lands mid-run (a different file, e.g. `market_tree.json`) doesn't
  reject the push with a non-fast-forward error.

| Action                          | Version | Used in                              |
| ------------------------------- | ------- | ------------------------------------ |
| `actions/checkout`              | `v7`    | all workflows                        |
| `actions/setup-node`            | `v6`    | `deploy.yml`                         |
| `actions/upload-pages-artifact` | `v5`    | `deploy.yml`                         |
| `actions/deploy-pages`          | `v5`    | `deploy.yml`                         |
| `actions/setup-python`          | `v6`    | `kill-stats*.yml`, `market-*.yml`    |
| `actions/cache`                 | `v6`    | `kill-stats.yml`, `kill-stats-day.yml` |

- **`deploy.yml`** — builds the Vite site and deploys it to GitHub Pages on push
  to `main` or `workflow_dispatch`. It checks out the **tip of `main`**
  (`ref: main`) rather than the commit the run was pinned to: the data workflows
  dispatch it right after `git push`, and that dispatch can resolve to the
  pre-push commit (a propagation race), which would otherwise deploy stale data.
- **`kill-stats.yml`** — manual (`workflow_dispatch`) incremental kill-stats
  refresh (§4.2); on committing new data it dispatches `deploy.yml` via
  `gh workflow run` so the site republishes (needs `actions: write`). It passes
  the `ESI_USER_AGENT` repository **secret** to the script as an env var (§4.2).
  When the change touches the **latest day** (a new day rolled over or the most
  recent day's aggregate changed) it **skips its own deploy** and dispatches
  `market-prices.yml` instead — which regenerates the (latest-two-days) treemap
  prices and deploys — so new kill data is never published against stale prices.
- **`kill-stats-day.yml`** — the same, for a **single day**: a required `day`
  input (`YYYY-MM-DD`) drives `--day` to (re)aggregate just that day. It shares
  the `actions/cache` id lists and the `kill-stats` concurrency group with
  `kill-stats.yml`, and likewise dispatches `market-prices.yml` when the day it
  refreshed is the latest one.
- **`market-tree.yml`** — manual (`workflow_dispatch`) regeneration of
  `market_tree.json` (§4.1): downloads the official EVE SDE (JSONL) from CCP
  (`developers.eveonline.com`, latest build or a pinned `build` input), runs
  `build_market_tree.py`, and commits any change to `main` (then dispatches
  `deploy.yml`). The ~549&nbsp;MB SDE stays out of git. It first checks CCP's
  `latest.jsonl` build against the one `market_tree.json` was built from
  (via `scripts/sde_latest_build.py`) and **skips the download when unchanged**;
  a pinned `build` input forces a rebuild.
- **`market-prices.yml`** — manual (`workflow_dispatch`) regeneration of
  `market_prices.json` (§4.3): reruns `build_market_prices.py` against the
  committed kill-stats window and market tree (`all_window` / `rate` inputs),
  passing the `ESI_USER_AGENT` secret, and commits any change to `main` (then
  dispatches `deploy.yml`).

## 8. Architecture & repository layout

### 8.1 Architecture

- **Frontend:** React + [Vite](https://vitejs.dev/), TypeScript.
- **Hosting:** GitHub Pages, fully static — no server-side runtime.
- **Data:** application data is served as static JSON under `public/data/`,
  generated from the SDE and public ESI/zKillboard data by the Python scripts in
  §4. `market_tree.json` is **committed**, so the site deploys without the
  ~549&nbsp;MB SDE dump in CI.
- **Images:** item icons/renders come from the public, key-less EVE image server
  (§5) — no ESI authentication.
- **Authentication (planned):** EVE SSO via the PKCE flow, client-side only;
  tokens stored in browser cookies, no client secret shipped (§6).
- **Automation:** GitHub Actions build and deploy on push to `main`, plus manual
  data-refresh workflows (§7).

### 8.2 Static Data Export (SDE)

The SDE is EVE Online's authoritative static data set (types, groups,
categories, blueprints, map data, …), distributed as JSONL (one JSON object per
line). This project consumes the JSONL dump (folder
`eve-online-static-data-<build>-jsonl/` in local development).

- The dump is **gitignored** (~549&nbsp;MB); only the generated
  `market_tree.json` is committed. Locally it is expected at the folder above.
- A `_sde.jsonl` manifest identifies the build, e.g.
  `{"_key": "sde", "buildNumber": 3409592, "releaseDate": "2026-06-25T12:00:48Z"}`.
- Records are keyed by `_key` and carry localized `name` maps (`en`, `de`,
  `fr`, `ja`, …); the app uses the **English** (`en`) names only (§3).

### 8.3 Repository layout

```
.
├── public/
│   ├── data/
│   │   ├── market_tree.json       # Generated market-group item tree (committed, §4.1)
│   │   ├── market_prices.json     # Per-day average prices for treemap tiles (committed, §4.3)
│   │   └── kill_stats/            # Per-day destroyed/dropped files + index.json (§4.2)
│   └── vite.svg
├── scripts/
│   ├── build_market_tree.py       # SDE marketGroups + types → market tree (§4.1)
│   ├── build_kill_stats.py        # zKillboard + ESI killmail aggregation (§4.2)
│   ├── build_market_prices.py     # ESI/zKillboard → per-day prices (§4.3)
│   ├── esi_env.py                 # Reads the ESI User-Agent from ESI_USER_AGENT / .env
│   └── sde_latest_build.py        # Prints CCP's latest SDE build number
├── src/
│   ├── components/
│   │   ├── MarketTreeView.tsx     # Left pane: market group tree (§1.2)
│   │   ├── ItemDetail.tsx         # Right pane: image, name, kill cards (§1.3)
│   │   ├── MarketHistoryChart.tsx # Price/volume + kill overlay chart (§1.3.1)
│   │   └── TreemapView.tsx        # Tree Map view (§2)
│   ├── App.tsx                    # View switcher, layout + data loading
│   ├── eve.ts                     # EVE image server + ESI history helpers
│   ├── treemap.ts                 # Dependency-free squarified treemap layout
│   └── types.ts                   # Market tree / kill / price data types
├── .github/workflows/             # deploy, kill-stats, kill-stats-day, market-tree, market-prices (§7)
├── CLAUDE.md                      # Guide for Claude
├── README.md                      # Setup, build, run, deploy
└── SPEC.md                        # This file — UI/feature + data/architecture spec
```

## Open items

- [x] Right pane: market history chart with daily destroyed/dropped overlay (§1.3.1)
- [x] Tree Map view: value-sized, change-colored, grouped treemap (§2)
- [ ] Right pane: add description and market group path (§1.3)
- [ ] Tree Map: ship overlays, tag labels, alternative metrics (§2.4)
- [ ] Enumerate ship classification IDs (§3)
- [ ] Define EVE SSO sign-in behavior (§6)
