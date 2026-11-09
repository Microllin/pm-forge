import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Code,
  Download,
  Eye,
  Loader2,
  Pencil,
  Save,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { MarkdownText } from "../chat/markdown";
import { formatSize, getItem, putContent, rawUrl, type FileItem } from "./api";

/** 编辑器与语言包较大，打开文件时才加载（不进首屏包）。 */
const CodeEditor = lazy(() => import("./CodeEditor"));

/**
 * 单个文件的查看与编辑。用哪个查看器由服务端的结论决定：带 content 的是文本类
 * （Markdown / HTML / 其他文本），否则按 kind 走图片、PDF 或「暂不支持预览」。
 *
 * - Markdown：默认渲染，可切到编辑。
 * - HTML：默认在无同源权限的 sandbox iframe 里预览（脚本跑得了，但碰不到本页面），
 *   可切到源码 / 编辑。
 * - 其他文本：带行号显示，可编辑。
 * - 保存带上打开时的版本：期间文件在别处被改过，服务端返回 412，这里提示而不覆盖。
 */
export function FileViewer({
  path,
  editOnOpen = false,
  onClose,
  onDirtyChange,
}: {
  path: string;
  /** 打开即进入编辑（刚新建的空 Markdown）。 */
  editOnOpen?: boolean;
  onClose: () => void;
  /** 有未保存的修改时为 true——外壳据此在切走前确认。 */
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const item = useQuery({
    queryKey: ["files-item", path],
    queryFn: () => getItem(path),
  });
  const data = item.data;

  return (
    <div className="files-viewer">
      <header className="files-viewer-head">
        <button type="button" className="btn ghost" onClick={onClose}>
          <ArrowLeft size={14} /> 返回
        </button>
        <h2 className="files-viewer-title" title={path}>
          {data?.name ?? path.slice(path.lastIndexOf("/") + 1)}
        </h2>
        {data && <span className="muted small">{formatSize(data.size)}</span>}
        <span className="files-spacer" />
        {data && (
          <a
            className="btn ghost"
            href={rawUrl(data, true)}
            download={data.name}
          >
            <Download size={14} /> 下载
          </a>
        )}
      </header>
      {item.isPending && (
        <p className="muted files-pad">
          <Loader2 size={14} className="spin" /> 读取中…
        </p>
      )}
      {item.isError && (
        <p className="err-text files-pad">读取失败：{item.error.message}</p>
      )}
      {data && (
        <Body
          key={data.path}
          item={data}
          editOnOpen={editOnOpen}
          {...(onDirtyChange === undefined ? {} : { onDirtyChange })}
        />
      )}
    </div>
  );
}

function Body({
  item,
  editOnOpen,
  onDirtyChange,
}: {
  item: FileItem;
  editOnOpen: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  if (item.content !== null) {
    return (
      <TextBody
        item={item}
        content={item.content}
        editOnOpen={editOnOpen}
        {...(onDirtyChange === undefined ? {} : { onDirtyChange })}
      />
    );
  }
  if (item.kind === "image") {
    return (
      <div className="files-media">
        <img src={rawUrl(item)} alt={item.name} />
      </div>
    );
  }
  if (item.kind === "pdf") {
    return (
      <iframe className="files-frame" src={rawUrl(item)} title={item.name} />
    );
  }
  return (
    <div className="files-unsupported">
      <p>
        {item.contentOmitted === "too-large"
          ? "文件太大（超过 5 MB），不在线显示。"
          : "暂不支持在线预览这种格式。"}
      </p>
      <a className="btn primary" href={rawUrl(item, true)} download={item.name}>
        <Download size={14} /> 下载查看
      </a>
    </div>
  );
}

type Mode = "preview" | "source" | "edit";

function TextBody({
  item,
  content,
  editOnOpen,
  onDirtyChange,
}: {
  item: FileItem;
  content: string;
  editOnOpen: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const rich = item.kind === "markdown" || item.kind === "html";
  const [mode, setMode] = useState<Mode>(
    editOnOpen ? "edit" : rich ? "preview" : "source",
  );
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const dirty = mode === "edit" && draft !== content;
  // 保存时读最新草稿：⌘S 回调存在编辑器内部，闭包里的 draft 可能还是上一次渲染的值。
  const draftRef = useRef(content);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // 离开页面（关标签、刷新）时，有未保存的修改就让浏览器确认。
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const text = draftRef.current;
      const { entry } = await putContent(item.path, text, "overwrite", {
        ifMatch: item.version,
      });
      queryClient.setQueryData<FileItem>(["files-item", item.path], {
        ...item,
        ...entry,
        content: text,
      });
      await queryClient.invalidateQueries({ queryKey: ["files-list"] });
      setMessage({ ok: true, text: "已保存" });
    } catch (cause) {
      setMessage({
        ok: false,
        text: cause instanceof Error ? cause.message : "保存失败",
      });
    } finally {
      setSaving(false);
    }
  };

  const switchTo = (next: Mode) => {
    if (mode === "edit" && dirty && !window.confirm("有未保存的修改，放弃吗？"))
      return;
    if (mode === "edit") {
      setDraft(content);
      draftRef.current = content;
    }
    setMessage(null);
    setMode(next);
  };

  return (
    <>
      <div className="files-modebar" role="toolbar" aria-label="查看方式">
        {rich && (
          <button
            type="button"
            className={`chip${mode === "preview" ? " active" : ""}`}
            onClick={() => switchTo("preview")}
          >
            <Eye size={13} /> 预览
          </button>
        )}
        {rich && (
          <button
            type="button"
            className={`chip${mode === "source" ? " active" : ""}`}
            onClick={() => switchTo("source")}
          >
            <Code size={13} /> 源码
          </button>
        )}
        {!rich && mode !== "edit" && (
          <span className="muted small">{content.split("\n").length} 行</span>
        )}
        <span className="files-spacer" />
        {message && (
          <span className={message.ok ? "ok-text" : "err-text"} role="status">
            {message.text}
          </span>
        )}
        {mode === "edit" ? (
          <>
            <button
              type="button"
              className="btn ghost"
              onClick={() => switchTo(rich ? "preview" : "source")}
            >
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={saving || !dirty}
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <Save size={13} />
              )}{" "}
              保存
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => switchTo("edit")}
          >
            <Pencil size={13} /> 编辑
          </button>
        )}
      </div>

      {mode === "preview" && item.kind === "markdown" && (
        <div className="files-doc">
          <MarkdownText text={content} streaming={false} />
        </div>
      )}
      {mode === "preview" && item.kind === "html" && (
        // 没有 allow-same-origin：页面里的脚本运行在不透明来源，读不到本站的接口与 cookie。
        <iframe
          className="files-frame"
          sandbox="allow-scripts"
          srcDoc={content}
          title={item.name}
        />
      )}
      {(mode === "source" || mode === "edit") && (
        <Suspense
          fallback={
            <p className="muted files-pad">
              <Loader2 size={14} className="spin" /> 加载编辑器…
            </p>
          }
        >
          <CodeEditor
            key={mode}
            filename={item.name}
            value={mode === "edit" ? draft : content}
            readOnly={mode === "source"}
            onChange={(next) => {
              draftRef.current = next;
              setDraft(next);
              setMessage(null);
            }}
            onSave={() => {
              if (draftRef.current !== content && !saving) void save();
            }}
          />
        </Suspense>
      )}
    </>
  );
}
