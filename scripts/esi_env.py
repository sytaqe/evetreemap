# SPDX-License-Identifier: CC0-1.0
# This file is released into the public domain under the CC0 1.0 Universal license.
"""Resolve the ESI ``User-Agent`` from the environment.

ESI etiquette wants a descriptive ``User-Agent`` with a contact address, but we
don't want that address published in the repo. So the whole UA string is read
from the ``ESI_USER_AGENT`` environment variable instead of being hard-coded:

- **Locally:** put it in a ``.env`` file at the repo root (gitignored), e.g.
  ``ESI_USER_AGENT=evetreemap/1.0 (+https://github.com/you/evetreemap; you@example.com)``.
- **CI:** expose a GitHub Actions secret named ``ESI_USER_AGENT`` as an env var
  on the step that runs the script.

The loader is dependency-free (no python-dotenv) and never overwrites a variable
already set in the real environment, so CI secrets take precedence over ``.env``.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ENV_VAR = "ESI_USER_AGENT"


def _load_dotenv(path: Path) -> None:
    """Load simple ``KEY=VALUE`` lines from ``path`` into ``os.environ``.

    Blank lines and ``#`` comments are ignored, surrounding quotes are stripped,
    and existing environment variables are left untouched (so real env / CI
    secrets win over the file).
    """
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


def user_agent() -> str:
    """Return the ESI ``User-Agent`` from ``ESI_USER_AGENT`` (env or ``.env``).

    Exits with a helpful message if it is unset, rather than falling back to a
    hard-coded contact address.
    """
    _load_dotenv(REPO_ROOT / ".env")
    ua = os.environ.get(ENV_VAR, "").strip()
    if not ua:
        sys.exit(
            f"error: {ENV_VAR} is not set. Put the full ESI User-Agent (with a "
            f"contact address) in a local .env file ({ENV_VAR}=...), or, in CI, a "
            f"GitHub secret exposed as {ENV_VAR}. See README (Getting started)."
        )
    return ua
