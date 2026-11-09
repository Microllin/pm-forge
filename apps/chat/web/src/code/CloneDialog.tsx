import { useState } from "react";
import { GitBranch, X } from "lucide-react";

/**
 * 克隆仓库的对话框。
 *
 * 只收三样：仓库地址、仓库名（可空，默认从地址最后一段推）、分支（可空）。
 * 地址的合法性由服务端校验（挡 ext:: 这类能执行命令的传输协议），这里只挡空值；
 * 真正的进度与报错显示在页面上的输出面板里，不开对话框内的第二条流水线。
 */
export function CloneDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: { url: string; name?: string; branch?: string }) => void;
}): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const trimmed = url.trim();
    if (trimmed === "") {
      setError("仓库地址不能为空");
      return;
    }
    onSubmit({
      url: trimmed,
      ...(name.trim() === "" ? {} : { name: name.trim() }),
      ...(branch.trim() === "" ? {} : { branch: branch.trim() }),
    });
  };

  return (
    <div
      className="files-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="files-dialog" role="dialog" aria-label="从 Git 克隆">
        <header className="files-dialog-head">
          <h2>
            <GitBranch size={16} /> 从 Git 克隆
          </h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="files-dialog-body clone-form">
          <label>
            <span>仓库地址</span>
            <input
              autoFocus
              value={url}
              placeholder="https://github.com/org/repo.git 或 git@github.com:org/repo.git"
              aria-label="仓库地址"
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
          <label>
            <span>
              仓库名 <em className="muted">（不填就取地址最后一段）</em>
            </span>
            <input
              value={name}
              placeholder="例：RouteHub"
              aria-label="仓库名"
              onChange={(e) => {
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
          <label>
            <span>
              分支 <em className="muted">（不填就是远端默认分支）</em>
            </span>
            <input
              value={branch}
              placeholder="例：main"
              aria-label="分支"
              onChange={(e) => {
                setBranch(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </label>
          {error !== null && (
            <p className="err-text" role="alert">
              {error}
            </p>
          )}
          <p className="muted small">
            私有仓库直接贴网页上的 HTTPS 地址即可：需要账号时会自动改用 SSH
            地址重试，用的是运行 PMForge 这台机器的 SSH 密钥（不会弹窗要密码）。
            仓库太大时首次克隆会比较久，进度会实时显示在页面上。
          </p>
        </div>
        <footer className="files-dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" onClick={submit}>
            克隆
          </button>
        </footer>
      </div>
    </div>
  );
}
