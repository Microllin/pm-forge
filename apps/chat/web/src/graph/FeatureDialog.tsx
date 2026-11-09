import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import {
  createFeature,
  updateFeature,
  type FeatureNode,
} from "../analysis/api";

/**
 * 功能节点的新建 / 编辑。
 *
 * 手工改过的节点在服务端会被记成 `source: "manual"`——「重新分析这一支」时
 * 要能点名「会覆盖你手改过的这几个」，而不是笼统地警告「会覆盖」。
 */
export function FeatureDialog({
  productId,
  node,
  parentId,
  onClose,
  onSaved,
}: {
  productId: string;
  /** 有值 = 编辑它；没有 = 新建。 */
  node?: FeatureNode | undefined;
  /** 新建时挂在谁下面；不给 = 一级功能。 */
  parentId?: string | undefined;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(node?.name ?? "");
  const [duty, setDuty] = useState(node?.duty ?? "");
  const [evidence, setEvidence] = useState((node?.evidence ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const fields = {
        name: name.trim(),
        duty: duty.trim(),
        evidence,
      };
      if (node) await updateFeature(node.id, fields);
      else
        await createFeature(productId, {
          ...fields,
          ...(parentId === undefined ? {} : { parentId }),
        });
      await onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header className="dialog-head">
          <h2>{node ? "编辑功能" : "新建功能"}</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <label className="field">
          功能名称
          <input
            ref={nameRef}
            value={name}
            maxLength={120}
            placeholder="用户能说出口的那种，如「渠道健康监控」"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          职责（一句话）
          <textarea
            rows={2}
            maxLength={1000}
            placeholder="它为谁做了什么"
            value={duty}
            onChange={(e) => setDuty(e.target.value)}
          />
        </label>
        <label className="field">
          代码证据（一行一条）
          <textarea
            rows={4}
            maxLength={2000}
            placeholder={
              "apps/console/app/pages/infra\napps/console/server/api/machines"
            }
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
          <span className="field-hint">
            「向下拆一层」时 AI 只扫这几条路径。留空的话它只能重扫整个代码目录，
            又慢又容易把别的分支的功能带进来。
          </span>
        </label>

        {error !== null && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || name.trim() === ""}
          >
            {busy && <Loader2 size={13} className="spin" />}
            {node ? "保存" : "创建"}
          </button>
        </footer>
      </form>
    </div>
  );
}
