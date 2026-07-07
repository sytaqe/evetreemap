// SPDX-License-Identifier: CC0-1.0
// This file is released into the public domain under the CC0 1.0 Universal license.
import { useState } from "react";
import type { MarketGroup, MarketType } from "../types.ts";
import { typeIconUrl } from "../eve.ts";

interface Props {
  roots: MarketGroup[];
  selectedId: number | null;
  onSelect: (item: MarketType) => void;
}

/** Left-pane tree of market groups and their item types. */
export function MarketTreeView({ roots, selectedId, onSelect }: Props) {
  // Open/closed state is held centrally so it can be reset with "Collapse all".
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());

  const toggle = (id: number) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const collapseAll = () => setOpenIds(new Set());

  return (
    <>
      <div className="tree-toolbar">
        <button
          type="button"
          className="tree-toolbar-btn"
          onClick={collapseAll}
          disabled={openIds.size === 0}
        >
          Collapse all
        </button>
      </div>
      <ul className="tree tree-root" role="tree">
        {roots.map((group) => (
          <GroupNode
            key={group.id}
            group={group}
            depth={0}
            openIds={openIds}
            onToggle={toggle}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </>
  );
}

interface GroupProps {
  group: MarketGroup;
  depth: number;
  openIds: Set<number>;
  onToggle: (id: number) => void;
  selectedId: number | null;
  onSelect: (item: MarketType) => void;
}

function GroupNode({
  group,
  depth,
  openIds,
  onToggle,
  selectedId,
  onSelect,
}: GroupProps) {
  const open = openIds.has(group.id);
  const indent = { paddingLeft: `${depth * 14 + 8}px` };

  return (
    <li className="tree-item" role="treeitem" aria-expanded={open}>
      <button
        type="button"
        className="tree-group"
        style={indent}
        onClick={() => onToggle(group.id)}
      >
        <span className={`caret ${open ? "caret-open" : ""}`} aria-hidden>
          ▶
        </span>
        <span className="tree-label">{group.name}</span>
      </button>

      {open && (
        <ul className="tree" role="group">
          {group.groups.map((child) => (
            <GroupNode
              key={child.id}
              group={child}
              depth={depth + 1}
              openIds={openIds}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
          {group.types.map((type) => (
            <li key={type.id} className="tree-item" role="none">
              <button
                type="button"
                role="treeitem"
                aria-selected={selectedId === type.id}
                className={`tree-type ${selectedId === type.id ? "selected" : ""}`}
                style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
                onClick={() => onSelect(type)}
              >
                <img
                  className="tree-type-icon"
                  src={typeIconUrl(type.id, 32)}
                  alt=""
                  loading="lazy"
                  width={20}
                  height={20}
                />
                <span className="tree-label">{type.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
