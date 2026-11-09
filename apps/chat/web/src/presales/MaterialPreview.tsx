import { Suspense, lazy, useEffect, useState } from "react";
import {
  ArrowLeft,
  Download,
  Eye,
  Loader2,
  Pencil,
  Save,
  TriangleAlert,
} from "lucide-react";

import { MarkdownText } from "../chat/markdown";
import { createRequest, json } from "../http";

/**
 * 售前材料预览。
 *
 * 材料大多数是 PPT / PDF / Word，**不要求能编辑**，但必须能看。分三档：
 * - **Markdown**：渲染阅读 + 切到编辑保存（这类是文字稿，改它是正当需求）。
 * - **docx / xlsx / pptx**：服务端抽出纯文本，按文本看。只读——这是「核对内容」
 *   不是 Office 渲染器，回写会毁掉原样式。
 * - **pdf / 图片 / 视频**：直接用原始文件地址给浏览器内置查看器。
 *
 * 看不了时明确说「请下载查看」，不留一个让人猜原因的空屏。
 */
const api = createRequest("/api");

const CodeEditor = lazy(() => import("../files/CodeEditor"));

interface Preview {
  kind: "markdown" | "text" | "docx" | "xlsx" | "pptx" | "unsupported";
  name: string;
  editable: boolean;
  text?: string;
  truncated?: boolean;
  reason?: string;
  filePath?: string;
}

const MEDIA = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
]);
const VIDEO = new Set(["mp4", "mov", "webm"]);

const extOf = (name: string): string =>
  name.slice(name.lastIndexOf(".") + 1).toLowerCase();

const fmtSize = (bytes: number): string => {
  if (bytes < 1024 * 1024)
    return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export function MaterialPreview({
  versionId,
  fileName,
  fileSize,
  onClose,
}: {
  versionId: string;
  fileName: string;
  fileSize: number;
  onClose: () => void;
}): React.JSX.Element {
  const [preview, setPreview] = useState<Preview | null>(null);
  // 媒体文件不需要请求预览接口，直接从「加载中」开始就行——初值算出来，
  // 不在 effect 里同步 setState（那会触发级联渲染）。
  const [loading, setLoading] = useState(
    !(MEDIA.has(extOf(fileName)) || VIDEO.has(extOf(fileName))),
  );
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const ext = extOf(fileName);
  const inline = MEDIA.has(ext) || VIDEO.has(ext);
  const url = `/api/presales/versions/${encodeURIComponent(versionId)}/file`;

  useEffect(() => {
    // 图片 / PDF / 视频直接给浏览器内置查看器，不调预览接口。
    if (inline) return;
    let alive = true;
    void api<Preview>(
      `/presales/versions/${encodeURIComponent(versionId)}/preview`,
    )
      .then((result) => {
        if (!alive) return;
        setPreview(result);
        if (result.editable) setDraft(result.text ?? "");
      })
      .catch((cause: unknown) => {
        if (alive) {
          setError(cause instanceof Error ? cause.message : "读取失败");
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [versionId, inline]);

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/presales/versions/${encodeURIComponent(versionId)}/preview`, {
        method: "PUT",
        ...json({ text: draft }),
      });
      setPreview((p) => (p === null ? p : { ...p, text: draft }));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    preview !== null &&
    preview.editable &&
    draft !== null &&
    draft !== preview.text;

  return (
    <div className="presales-scrim" role="dialog" aria-modal="true">
      <div className="presales-preview">
        <header className="presales-preview-head">
          <button type="button" className="btn ghost" onClick={onClose}>
            <ArrowLeft size={14} /> 返回
          </button>
          <h3 title={fileName}>{fileName}</h3>
          <span className="muted small">{fmtSize(fileSize)}</span>
          <span className="presales-preview-spacer" />
          {preview?.editable && (
            <button
              className="btn primary"
              disabled={saving || !dirty}
              onClick={() => {
                void save();
              }}
            >
              <Save size={13} />
              {saving ? "保存中…" : dirty ? "保存" : "已保存"}
            </button>
          )}
          <a className="btn ghost" href={url} download={fileName}>
            <Download size={13} /> 下载
          </a>
        </header>

        {loading && (
          <p className="muted presales-preview-pad">
            <Loader2 size={14} className="spin" /> 读取中…
          </p>
        )}
        {error !== null && (
          <p className="presales-error presales-preview-pad">
            <TriangleAlert size={13} /> {error}
          </p>
        )}

        <div className="presales-preview-body">
          {inline && ext === "pdf" && (
            <iframe
              className="presales-preview-frame"
              src={url}
              title={fileName}
            />
          )}
          {inline && VIDEO.has(ext) && (
            // biome-ignore lint/a11y/useMediaCaption: 售前演示视频本身没有字幕轨
            <video className="presales-preview-video" src={url} controls />
          )}
          {inline && MEDIA.has(ext) && ext !== "pdf" && (
            <div className="presales-preview-media">
              <img src={url} alt={fileName} />
            </div>
          )}

          {preview?.kind === "markdown" && (
            <MarkdownBody
              text={draft ?? preview.text ?? ""}
              onEdit={(next) => {
                setDraft(next);
                setSaved(false);
              }}
            />
          )}

          {preview !== null &&
            !preview.editable &&
            preview.text !== undefined &&
            preview.kind !== "unsupported" && (
              <>
                <p className="muted small presales-preview-note">
                  <Eye size={12} />{" "}
                  只读：这一步抽出的是文字内容，表格边框、图片与版式不保留。
                  {preview.truncated === true && "（内容过长，只显示前一部分）"}
                </p>
                <pre className="presales-preview-text">{preview.text}</pre>
              </>
            )}

          {preview?.kind === "unsupported" && (
            <div className="presales-preview-unsupported">
              <p>{preview.reason ?? "这种格式不在线预览。"}</p>
              <a className="btn primary" href={url} download={fileName}>
                <Download size={14} /> 下载查看
              </a>
            </div>
          )}
        </div>

        {saved && <p className="presales-preview-saved">已保存</p>}
      </div>
    </div>
  );
}

/** Markdown：默认渲染，可切到源码编辑。 */
function MarkdownBody({
  text,
  onEdit,
}: {
  text: string;
  onEdit: (next: string) => void;
}): React.JSX.Element {
  const [source, setSource] = useState(false);
  return (
    <>
      <div className="presales-preview-modebar">
        <button
          type="button"
          className={`chip${source ? "" : " active"}`}
          onClick={() => {
            setSource(false);
          }}
        >
          <Eye size={13} /> 预览
        </button>
        <button
          type="button"
          className={`chip${source ? " active" : ""}`}
          onClick={() => {
            setSource(true);
          }}
        >
          <Pencil size={13} /> 编辑
        </button>
      </div>
      {source ? (
        <Suspense
          fallback={
            <p className="muted small pad">
              <Loader2 size={14} className="spin" /> 加载编辑器…
            </p>
          }
        >
          <CodeEditor
            value={text}
            filename="material.md"
            onChange={(next) => {
              onEdit(next);
            }}
          />
        </Suspense>
      ) : (
        <article className="presales-preview-md">
          <MarkdownText text={text} streaming={false} />
        </article>
      )}
    </>
  );
}
