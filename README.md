<!--
SPDX-License-Identifier: CC0-1.0
This file is released into the public domain under the CC0 1.0 Universal license.
-->

# EVE Treemap

An interactive treemap visualization of EVE Online activity, built as a fully
static single-page application and deployed to GitHub Pages. All data is
prepared ahead of time and served as static JSON — there is no backend server.

Two views are implemented and selectable from the top of the UI:

- **Market Browser** — a market-group item tree with a detail pane showing the
  selected item's image, name, kill counts, and a The Forge price/volume chart
  with a daily destroyed/dropped overlay.
- **Tree Map** — a Finviz-style treemap where each item's tile area is its
  latest-day ISK value (`quantity × average price`) and its color is the
  day-over-day change. Two variants size tiles by `destroyed + dropped` or
  `destroyed` only.

> **Specification:** [`SPEC.md`](SPEC.md) is the full spec — UI/feature behavior
> (§1–§2), SDE classification (§3), data pipelines (§4), images/ESI (§5),
> authentication (§6), CI workflows (§7), and architecture & repository layout
> (§8). The release procedure lives in `RELEASE.md` (local only, gitignored).

## Getting started

### Prerequisites

- Node.js (LTS) and npm
- Python 3.x — only needed to regenerate the static data

### ESI User-Agent

The Python data scripts that call ESI/zKillboard read the full `User-Agent` —
including a contact address, as ESI etiquette expects — from the
`ESI_USER_AGENT` environment variable, so no address is hard-coded in the repo.
For local runs, copy `.env.example` to `.env` (gitignored) and set your own:

```bash
cp .env.example .env      # then edit ESI_USER_AGENT=...
```

In CI, set a GitHub Actions **secret** named `ESI_USER_AGENT`. The scripts exit
with an error if it is unset.

### Run

```bash
npm install               # install frontend dependencies
npm run dev               # dev server, served under the /evetreemap/ base path
```

`market_tree.json` is committed, so the app runs without the SDE dump.

### Build

```bash
npm run build             # produce the static site in dist/
npm run preview           # serve the production build locally
```

## Regenerating the static data

All application data lives under `public/data/` and is generated out of band by
the Python scripts in `scripts/` — see [`SPEC.md`](SPEC.md) §4 for the full
specification of each dataset and its format. These runs are heavy (ESI rate
limits) and are normally done through the manual GitHub Actions workflows
([`SPEC.md`](SPEC.md) §7), not on every build.

```bash
npm run data              # market tree   (SDE → market_tree.json)
npm run killstats         # kill stats    (zKillboard + ESI → kill_stats/)
npm run prices            # market prices (ESI/zKillboard → market_prices.json)
```

Regenerating the market tree needs the ~549&nbsp;MB SDE dump locally (or use the
`market-tree.yml` workflow, which downloads it in CI); the SDE itself is
gitignored. See [`SPEC.md`](SPEC.md) §8.2.

## Deployment

Pushing to the remote `main` branch triggers `.github/workflows/deploy.yml`,
which builds the Vite site and deploys it to GitHub Pages; it can also be run
manually via `workflow_dispatch`. The full set of workflows is documented in
[`SPEC.md`](SPEC.md) §7, and the release procedure in `RELEASE.md`.

## Conventions

- All UI labels, messages, and user-facing text are in **English**.
- When a change affects the specification, update both this README and
  [`SPEC.md`](SPEC.md) to match.
- Every source file begins with a CC0 1.0 Public Domain license header (see
  [`CLAUDE.md`](CLAUDE.md) for the exact text; use `#` comments for Python).

## License

Released into the public domain under the
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) license.

EVE Online and all related materials are property of
[CCP Games](https://www.ccpgames.com/). This is an unofficial, fan-made tool.
