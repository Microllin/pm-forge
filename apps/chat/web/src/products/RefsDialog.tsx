import { useEffect, useState } from "react";
import { FileText, Folder, Loader2, Plus, Trash2, X } from "lucide-react";

import { FolderPicker } from "../analysis/FolderPicker";
import type { Product } from "./api";

/** 与服务端 products.ts 的 MAX_REF_PATHS 一致。 */
const MAX_REF_PATHS = 8;

/**
 * 管理一个产品的「参考资料」：文档目录只能绑一个，而手册、产品线能力地图常常在它外面。
 * 这里可以额外挂几条目录或单个文件，Wiki 规划目录、写正文时一起读。
 *
 * 每次增删立即保存（整组替换），不做「编辑完再点保存」——条目少，即时生效更不容易忘点。
 */
export function RefsDialog({
  product,
  onSave,
  onClose,
}: {
  product: Product;
  onSave: (refPaths: string[]) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = product.refPaths ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy && !adding) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, adding]);

  const save = async (next: string[]): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  if (adding)
    return (
      <FolderPicker
        title={`给「${product.name}」加一条参考资料`}
        hint="可以选一个文档目录，也可以点选单个文件（比如产品线的能力地图）。代码请绑到代码目录，不放这里。"
        initialPath={product.folderPath ?? "/"}
        submitLabel="加上"
        allowFiles
        onClose={() => setAdding(false)}
        onPick={async (path) => {
          if (refs.includes(path)) {
            setAdding(false);
            return;
          }
          await save([...refs, path]);
          setAdding(false);
        }}
      />
    );

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>参考资料：{product.name}</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <p className="field-hint">
          文档目录之外、这个产品也要用到的材料（用户手册、后台手册、产品线能力地图等）。AI
          规划 Wiki 目录和写正文时会一起读。改了之后要重新发起规划才会生效。
        </p>

        {refs.length === 0 ? (
          <p className="muted small">还没挂参考资料。</p>
        ) : (
          <ul className="refs-list" aria-label="参考资料">
            {refs.map((path) => (
              <li key={path}>
                {path.slice(path.lastIndexOf("/") + 1).includes(".") ? (
                  <FileText size={13} className="faint" />
                ) : (
                  <Folder size={13} className="faint" />
                )}
                <code>{path}</code>
                <button
                  type="button"
                  className="icon-btn ghost"
                  aria-label={`移除 ${path}`}
                  title="移除"
                  disabled={busy}
                  onClick={() =>
                    // 失败已由 save 写进 error 显示，这里只是不让它变成未处理的 rejection。
                    void save(refs.filter((p) => p !== path)).catch(
                      () => undefined,
                    )
                  }
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {error !== null && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}

        <footer className="dialog-foot">
          {busy && <Loader2 size={13} className="spin" />}
          <button
            type="button"
            className="btn"
            disabled={busy || refs.length >= MAX_REF_PATHS}
            title={
              refs.length >= MAX_REF_PATHS
                ? `最多 ${String(MAX_REF_PATHS)} 条`
                : ""
            }
            onClick={() => setAdding(true)}
          >
            <Plus size={13} /> 添加
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={onClose}
          >
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
