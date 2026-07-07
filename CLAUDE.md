# EVE Treemap — Project Guide for Claude

Read `README.md` for the full application specification, architecture, data formats, and setup instructions.

Read `SPEC.md` for the detailed UI and feature specification: display columns, tag label conditions and colors, ship icon overlays, SDE data classification rules, and row background behavior.

Read `RELEASE.md` for the procedure to release changes to the remote `main` branch. `RELEASE.md` should be gitignored

## Key facts

- React + Vite frontend, deployed to GitHub Pages as a fully static site
- No backend server — all data is served as static JSON files under `public/data/`
- Python scripts handle ESI data fetching (`scripts/fetch_kills.py`) and SDE download (`scripts/download_sde.py`)
- GitHub Actions automate daily builds/deploys
- EVE SSO authentication uses PKCE (client-side only); tokens stored in browser cookies
- SDE files are gitignored and downloaded at build time

## Conventions

- When making changes that affect the specification, update `README.md` and `SPEC.md`  to reflect them.
- All UI labels, messages, and user-facing text must be in English.
- All source files must include a CC0 1.0 Public Domain license header at the top:
  ```
  // SPDX-License-Identifier: CC0-1.0
  // This file is released into the public domain under the CC0 1.0 Universal license.
  ```
  For Python files, use `#` comments instead of `//`.
