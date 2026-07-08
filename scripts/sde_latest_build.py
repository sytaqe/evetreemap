# SPDX-License-Identifier: CC0-1.0
# This file is released into the public domain under the CC0 1.0 Universal license.
"""Print CCP's latest EVE SDE build number.

Reads the small ``latest.jsonl`` manifest from the official Static Data Export
service and prints the ``buildNumber`` of its ``sde`` record. The market-tree
workflow compares this against the ``build`` field committed in
``market_tree.json`` to skip the ~549MB download when nothing changed.
"""

from __future__ import annotations

import json
import sys
import urllib.request

LATEST = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl"
UA = "evetreemap SDE version check (+https://github.com/sytaqe/evetreemap)"


def main() -> None:
    req = urllib.request.Request(LATEST, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8")
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec.get("_key") == "sde" and rec.get("buildNumber") is not None:
            print(rec["buildNumber"])
            return
    sys.exit("error: no 'sde' record with a buildNumber in latest.jsonl")


if __name__ == "__main__":
    main()
