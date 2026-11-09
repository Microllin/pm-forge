import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { listFolder } from "./api";

/**
 * 文件夹树。两处用：左侧导航、「移动到…」的目标选择。
 *
 * 每一层展开时才请求（与列表共用同一个查询缓存 ["files-list", path]），只显示文件夹。
 * 当前选中项的祖先自动展开——从面包屑或搜索结果跳进深层文件夹时，树跟着定位。
 */
export function FolderTree({
  selected,
  onSelect,
  disabledWithin = [],
  label = "文件夹",
  root = "/",
  rootName = "文件",
  hide = [],
}: {
  selected: string;
  onSelect: (path: string) => void;
  /** 「移动 / 复制到…」时传被操作的文件夹路径：它们自己和下面的都不能选（不能放进自己里面）。 */
  disabledWithin?: readonly string[];
  label?: string;
  /** 树从哪一层开始。「代码」入口从 /代码库 起，看不到也点不到它以外的目录。 */
  root?: string;
  rootName?: string;
  /** 不在树上出现的文件夹（文件库要藏起 /代码库）。 */
  hide?: readonly string[];
}): React.JSX.Element {
  const [opened, setOpened] = useState<Set<string>>(() => new Set([root]));
  const isOpen = (path: string) =>
    opened.has(path) || isAncestor(path, selected, root);
  const toggle = (path: string, open: boolean) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });

  return (
    <ul className="files-tree" role="tree" aria-label={label}>
      <TreeNode
        path={root}
        name={rootName}
        depth={0}
        selected={selected}
        isOpen={isOpen}
        onToggle={toggle}
        onSelect={onSelect}
        disabledWithin={disabledWithin}
        hide={hide}
      />
    </ul>
  );
}

/** `path` 是 `target` 的祖先（不含自己）。根自身是一切的祖先。 */
function isAncestor(path: string, target: string, root: string): boolean {
  if (path === target) return false;
  return path === root || target.startsWith(`${path}/`);
}

const within = (path: string, outer: string) =>
  path === outer || path.startsWith(`${outer}/`);

function TreeNode({
  path,
  name,
  depth,
  selected,
  isOpen,
  onToggle,
  onSelect,
  disabledWithin,
  hide,
}: {
  path: string;
  name: string;
  depth: number;
  selected: string;
  isOpen: (path: string) => boolean;
  onToggle: (path: string, open: boolean) => void;
  onSelect: (path: string) => void;
  disabledWithin: readonly string[];
  hide: readonly string[];
}): React.JSX.Element {
  const open = isOpen(path);
  const children = useQuery({
    queryKey: ["files-list", path],
    queryFn: () => listFolder(path),
    enabled: open,
  });
  const folders = (children.data?.entries ?? []).filter(
    (e) => e.isDir && !hide.some((h) => within(e.path, h)),
  );
  const disabled = disabledWithin.some((outer) => within(path, outer));
  const active = path === selected;

  return (
    <li role="treeitem" aria-expanded={open} aria-selected={active}>
      <div
        className={`files-tree-row${active ? " active" : ""}${disabled ? " disabled" : ""}`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        <button
          type="button"
          className="files-tree-twisty"
          aria-label={open ? `收起 ${name}` : `展开 ${name}`}
          onClick={() => onToggle(path, !open)}
        >
          {children.isFetching && open && !children.data ? (
            <Loader2 size={12} className="spin" />
          ) : open ? (
            <ChevronDown size={13} />
          ) : (
            <ChevronRight size={13} />
          )}
        </button>
        <button
          type="button"
          className="files-tree-name"
          disabled={disabled}
          onClick={() => {
            onSelect(path);
            onToggle(path, true);
          }}
        >
          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
          <span>{name}</span>
        </button>
      </div>
      {open && folders.length > 0 && (
        <ul role="group">
          {folders.map((f) => (
            <TreeNode
              key={f.path}
              path={f.path}
              name={f.name}
              depth={depth + 1}
              selected={selected}
              isOpen={isOpen}
              onToggle={onToggle}
              onSelect={onSelect}
              disabledWithin={disabledWithin}
              hide={hide}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
