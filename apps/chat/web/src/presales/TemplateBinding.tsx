import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link2, RefreshCw, TriangleAlert } from "lucide-react";

import { createRequest, json } from "../http";
import { listTemplates, templatesKey } from "./ai-api";
import { Select } from "../ui/Select";

/**
 * 库与售前模板的对照：绑的哪个模板、条目对上了几项、哪些对不上、模板还要求什么。
 *
 * 对号是自动的（按名称 / 别名）。逐项的对照结果（含模板要求而库里没有的缺口行）
 * 直接画在材料清单里；这一条只给总数、一键补齐与换模板。
 * 说明与检查要点跟着模板实时变——它们是 AI 审阅的标准，改模板就是改标准。
 */

const request = createRequest("/api");

interface SlotLink {
  id: string;
  title: string;
  link: "linked" | "outside" | "unmatched" | "none";
}

export function TemplateBinding({
  libId,
  isCompany,
  templateId,
  templateName,
  slots,
  gaps,
  busy,
  onSync,
  onChanged,
}: {
  libId: string;
  isCompany: boolean;
  templateId: string | null;
  templateName: string | null;
  slots: SlotLink[];
  gaps: { id: string; name: string; stageLabel: string; required: boolean }[];
  busy: boolean;
  onSync: () => void;
  onChanged: () => void;
}): React.JSX.Element {
  const templates = useQuery({
    queryKey: templatesKey,
    queryFn: listTemplates,
  });
  const list = templates.data ?? [];
  const fallback =
    list.find((t) => t.builtinKey === (isCompany ? "company" : "product"))
      ?.id ??
    list[0]?.id ??
    "";
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bind = (id: string | null): void => {
    setSaving(true);
    setError(null);
    request<{ linked: number; unmatched: string[]; gaps: string[] }>(
      `/presales/${libId}/template`,
      { method: "POST", ...json({ templateId: id }) },
    )
      .then((r) => {
        setMessage(
          id === null
            ? "已解绑模板。"
            : `对上 ${String(r.linked)} 项${r.unmatched.length > 0 ? `；${String(r.unmatched.length)} 项对不上（${r.unmatched.join("、")}）` : ""}${r.gaps.length > 0 ? `；模板还要求 ${String(r.gaps.length)} 项库里没有` : ""}。对得不对可以在每行「编辑」里改。`,
        );
        onChanged();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "绑定失败");
      })
      .finally(() => {
        setSaving(false);
      });
  };

  if (templateId === null) {
    const value = picked ?? fallback;
    return (
      <div className="presales-tpl warn">
        <TriangleAlert size={14} aria-hidden="true" />
        <span>
          这本库还没绑售前模板：材料对不上「应具备哪些」，AI
          审阅也没有检查要点可依。
        </span>
        <Select
          className="input sm"
          value={value}
          aria-label="选模板"
          onChange={(v) => {
            setPicked(v);
          }}
          options={list.map((t) => ({ value: t.id, label: t.name }))}
        />
        <button
          type="button"
          className="btn primary"
          disabled={saving || value === ""}
          onClick={() => {
            bind(value);
          }}
        >
          <Link2 size={13} /> 绑定并对号
        </button>
        {error !== null && <span className="presales-error">{error}</span>}
      </div>
    );
  }

  const linked = slots.filter((s) => s.link === "linked").length;
  const unmatched = slots.filter((s) => s.link === "unmatched");
  const outside = slots.filter((s) => s.link === "outside");
  const total = linked + gaps.length;

  return (
    <div className="presales-tpl-wrap">
      <div className="presales-tpl">
        <span className="presales-tpl-name">
          <Link2 size={13} aria-hidden="true" /> 标准模板：
          <b>{templateName ?? "（已删除）"}</b>
        </span>
        <span className="muted small">
          对上 {linked}/{total} 项
          {unmatched.length > 0 && (
            <b className="presales-gap"> · {unmatched.length} 项对不上</b>
          )}
          {outside.length > 0 && <> · {outside.length} 项模板外</>}
          {gaps.length > 0 && (
            <b className="presales-gap"> · 模板要求的缺 {gaps.length} 项</b>
          )}
        </span>
        <span className="presales-preview-spacer" />
        {gaps.length > 0 && (
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            title="把模板要求、库里还没有的几项一次性建成条目（只加不删）"
            onClick={onSync}
          >
            <RefreshCw size={12} /> 缺的全部加入清单
          </button>
        )}
        <Select
          className="input sm"
          value={templateId}
          aria-label="换模板"
          disabled={saving}
          onChange={(v) => {
            if (
              window.confirm(
                "换模板会重新对号：材料与文件都不动，说明与检查要点改取新模板的。继续？",
              )
            )
              bind(v);
          }}
          options={list.map((t) => ({ value: t.id, label: t.name }))}
        />
      </div>
      {message !== null && <p className="muted small">{message}</p>}
      {error !== null && <p className="presales-error">{error}</p>}
    </div>
  );
}
