# SPDX-License-Identifier: CC0-1.0
# This file is released into the public domain under the CC0 1.0 Universal license.
"""Build the market-group item tree consumed by the frontend.

Parses the EVE SDE ``marketGroups.jsonl`` and ``types.jsonl`` files and emits a
single nested JSON tree to ``public/data/market_tree.json``. Groups with no
published types anywhere in their subtree are pruned so the tree matches what a
market browser would show.

Usage:
    python scripts/build_market_tree.py [--sde DIR] [--out FILE]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SDE = REPO_ROOT / "eve-online-static-data-3409592-jsonl"
DEFAULT_OUT = REPO_ROOT / "public" / "data" / "market_tree.json"


def read_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


def en(name_map) -> str:
    """Return the English label from a localized name map (best effort)."""
    if isinstance(name_map, dict):
        return name_map.get("en") or next(iter(name_map.values()), "")
    return str(name_map or "")


def build(sde_dir: Path):
    groups_path = sde_dir / "marketGroups.jsonl"
    types_path = sde_dir / "types.jsonl"
    for p in (groups_path, types_path):
        if not p.exists():
            sys.exit(f"error: missing SDE file {p}")

    # 1. Load market groups into a node map.
    nodes: dict[int, dict] = {}
    parent_of: dict[int, int | None] = {}
    for row in read_jsonl(groups_path):
        gid = row["_key"]
        nodes[gid] = {
            "id": gid,
            "name": en(row.get("name")),
            "iconID": row.get("iconID"),
            "groups": [],
            "types": [],
        }
        parent_of[gid] = row.get("parentGroupID")

    # 2. Attach published types to their market group.
    type_count = 0
    for row in read_jsonl(types_path):
        if not row.get("published"):
            continue
        gid = row.get("marketGroupID")
        if gid is None or gid not in nodes:
            continue
        nodes[gid]["types"].append({"id": row["_key"], "name": en(row.get("name"))})
        type_count += 1

    # 3. Wire up the group hierarchy.
    roots: list[dict] = []
    for gid, node in nodes.items():
        parent = parent_of.get(gid)
        if parent is not None and parent in nodes:
            nodes[parent]["groups"].append(node)
        else:
            roots.append(node)

    # 4. Prune subtrees that contain no types, then sort by name.
    def prune(node: dict) -> bool:
        node["groups"] = [g for g in node["groups"] if prune(g)]
        node["groups"].sort(key=lambda g: g["name"].lower())
        node["types"].sort(key=lambda t: t["name"].lower())
        return bool(node["groups"] or node["types"])

    roots = [r for r in roots if prune(r)]
    roots.sort(key=lambda r: r["name"].lower())

    return roots, len(nodes), type_count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sde", type=Path, default=DEFAULT_SDE,
                        help="Path to the unpacked SDE JSONL directory")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT,
                        help="Output JSON file path")
    args = parser.parse_args()

    sde_dir: Path = args.sde
    build_number = None
    manifest = sde_dir / "_sde.jsonl"
    if manifest.exists():
        for row in read_jsonl(manifest):
            build_number = row.get("buildNumber")
            break

    roots, group_count, type_count = build(sde_dir)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {"build": build_number, "roots": roots}
    with args.out.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    size_kb = args.out.stat().st_size / 1024
    print(f"Wrote {args.out} ({size_kb:.0f} KB)")
    print(f"  build {build_number}: {len(roots)} root groups, "
          f"{group_count} groups total, {type_count} types")


if __name__ == "__main__":
    main()
