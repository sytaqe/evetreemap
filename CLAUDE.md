# EVE Treemap — Project Guide for Claude

Read `README.md` for the full application specification, architecture, data formats, and setup instructions.

Read `SPEC.md` for the detailed UI and feature specification: display columns, tag label conditions and colors, ship icon overlays, SDE data classification rules, and row background behavior.

Read `RELEASE.md` for the procedure to release changes to the remote `main` branch. `RELEASE.md` should be gitignored

## Key facts

- React + Vite frontend, deployed to GitHub Pages as a fully static site
- No backend server — all data is served as static JSON files under `public/data/`
- Python scripts under `scripts/` prepare the static data: `build_market_tree.py` (SDE → market tree), `build_kill_stats.py` (zKillboard + ESI killmail aggregation), and `build_market_prices.py` (ESI/zKillboard → per-day prices)
- GitHub Actions build/deploy to GitHub Pages on push to `main`, plus manual workflows to regenerate the market tree, kill stats, and market prices
- EVE SSO authentication (planned) uses PKCE (client-side only); tokens stored in browser cookies
- The SDE dump is gitignored (~549 MB); the generated `market_tree.json` is committed, so CI deploys without downloading the SDE

## Conventions

- When making changes that affect the specification, update `README.md` and `SPEC.md`  to reflect them.
- All UI labels, messages, and user-facing text must be in English.
- All source files must include a CC0 1.0 Public Domain license header at the top:
  ```
  // SPDX-License-Identifier: CC0-1.0
  // This file is released into the public domain under the CC0 1.0 Universal license.
  ```
  For Python files, use `#` comments instead of `//`.
