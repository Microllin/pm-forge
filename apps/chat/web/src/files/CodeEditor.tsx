import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * 代码编辑器 / 只读高亮查看（CodeMirror 6）。
 *
 * 单独一个模块、由 FileViewer 按需加载：编辑器与各语言包有几百 KB，只在打开文件时才下载。
 * 语言按扩展名选；不认识的按纯文本（仍有行号、查找、括号匹配）。
 */

function languageFor(filename: string): Extension[] {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
    case "mdown":
    case "mkd":
      return [markdown()];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "json":
    case "jsonc":
      return [json()];
    case "html":
    case "htm":
    case "xhtml":
    case "vue":
      return [html()];
    case "css":
    case "scss":
    case "less":
      return [css()];
    case "py":
      return [python()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "sql":
      return [sql()];
    case "xml":
    case "svg":
      return [xml()];
    default:
      return [];
  }
}

/** 与 3200 的令牌一致：等宽字体、13px、浅色。 */
const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--text-label)",
    backgroundColor: "var(--bg)",
  },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.65" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-soft)",
    borderRight: "1px solid var(--line)",
    color: "var(--muted)",
  },
  ".cm-content": { padding: "12px 0" },
  "&.cm-focused": { outline: "none" },
});

export default function CodeEditor({
  value,
  filename,
  readOnly = false,
  onChange,
  onSave,
}: {
  value: string;
  filename: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  /** ⌘S / Ctrl+S。 */
  onSave?: () => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // 回调放 ref 里：编辑器只建一次，回调变了不必重建（重建会丢光标与撤销历史）。
  const callbacks = useRef({ onChange, onSave });
  useEffect(() => {
    callbacks.current = { onChange, onSave };
  }, [onChange, onSave]);

  useEffect(() => {
    if (!host.current) return;
    const save = () => {
      callbacks.current.onSave?.();
      return true;
    };
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // 保存的快捷键放在最前面：比 basicSetup 里的默认键位优先。
          keymap.of([
            { key: "Mod-s", run: save, preventDefault: true },
            { key: "Ctrl-s", run: save, preventDefault: true },
            indentWithTab,
          ]),
          basicSetup,
          theme,
          EditorView.lineWrapping,
          ...languageFor(filename),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            "aria-label": readOnly ? "源码" : "编辑内容",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    if (!readOnly) editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
    // 只在文件 / 模式变化时重建；value 的后续变化走下面的同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, readOnly]);

  // 外部换了内容（比如保存后重新读到的版本）：与编辑器里不同才替换，避免打断正在输入。
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  return <div ref={host} className="files-cm" />;
}
