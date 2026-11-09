import { useEffect, useMemo, useState } from "react";
import { Camera, Loader2, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listLines } from "../products/api";
import { listEnvs } from "../products/envs-api";
import { Select } from "../ui/Select";
import {
  cancelCapture,
  captureStatus,
  listSnapshots,
  shotUrl,
  startCapture,
  type CodeVersion,
  type Snapshot,
  type SnapshotPage,
} from "./api";
import "./snapshots.css";

/**
 * 页面快照库（事实底座第三处，与文件库 / 代码库并列）。
 *
 * 每采一次存一版：浏览器真实渲染的截图 + 页面文字，带版本标记（提交 / 分支 / 标签 / PR 号）。
 * 左边选版本（最新在前），右边看这一版的页面；同一页面在历史版本里的样子可以直接对比。
 */

const STATUS_LABEL: Record<SnapshotPage["status"], string> = {
  ok: "正常",
  blank: "基本空白",
  redirected: "被跳走",
  skipped: "未截",
};

export default function SnapshotsPage(): React.JSX.Element {
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  const products = useMemo(
    () =>
      (lines.data ?? []).flatMap((l) =>
        l.products.map((p) => ({ product: p, lineName: l.name })),
      ),
    [lines.data],
  );
  const [productId, setProductId] = useState<string | null>(null);
  const product =
    products.find((p) => p.product.id === productId)?.product ??
    products.find((p) => p.product.codePath !== null)?.product ??
    products[0]?.product ??
    null;
  const envs = useQuery({
    queryKey: ["envs", product?.id],
    queryFn: () => listEnvs(product?.id ?? ""),
    enabled: product !== null,
  });
  const snaps = useQuery({
    queryKey: ["snapshots", product?.id],
    queryFn: () => listSnapshots(product?.id ?? ""),
    enabled: product !== null,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const versions = snaps.data ?? [];
  const current = versions.find((s) => s.id === picked) ?? versions[0] ?? null;

  return (
    <div className="sn-page">
      {/* 标题与说明由外壳顶栏统一显示（MENU_TAGLINE），这里不再重复，只留选产品。 */}
      <header className="sn-toolbar">
        <Select
          className="input sm"
          aria-label="选择产品"
          value={product?.id ?? ""}
          placeholder="选择产品"
          options={products.map((p) => ({
            value: p.product.id,
            label: `${p.lineName} / ${p.product.name}`,
          }))}
          onChange={(v) => {
            setProductId(v);
            setPicked(null);
          }}
        />
      </header>
      <CaptureBar productId={product?.id ?? null} envs={envs.data ?? []} />
      {snaps.isError && (
        <p className="err-text small pad" role="alert">
          读不到快照：{snaps.error.message}
          <button
            type="button"
            className="link-btn"
            onClick={() => void snaps.refetch()}
          >
            重试
          </button>
        </p>
      )}
      <Body
        productName={product?.name ?? null}
        versions={versions}
        current={current}
        loading={snaps.isPending}
        onPick={setPicked}
      />
    </div>
  );
}

function CaptureBar({
  productId,
  envs,
}: {
  productId: string | null;
  envs: { id: string; baseUrl: string; role: string; hasCredential: boolean }[];
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const usable = envs.filter((e) => e.hasCredential);
  const [envId, setEnvId] = useState<string | null>(null);
  const env = usable.find((e) => e.id === envId) ?? usable[0] ?? null;
  const [error, setError] = useState<string | null>(null);

  /**
   * 进度靠轮询而不是连接：采集跑在服务端，关掉页面、切走再回来都能接上。
   * 有任务在跑时才 2 秒问一次，跑完自动停。
   */
  const job = useQuery({
    queryKey: ["snapshot-job", productId],
    queryFn: () => captureStatus(productId ?? ""),
    enabled: productId !== null,
    refetchInterval: (q) => {
      const j = q.state.data;
      return j === null ||
        j === undefined ||
        ["done", "failed", "cancelled"].includes(j.stage)
        ? false
        : 2000;
    },
  });
  const running =
    job.data !== undefined &&
    job.data !== null &&
    !["done", "failed", "cancelled"].includes(job.data.stage);

  // 跑完那一刻刷新版本列表：新的一版要马上出现在左边。
  useEffect(() => {
    if (job.data?.stage === "done")
      void queryClient.invalidateQueries({
        queryKey: ["snapshots", productId],
      });
  }, [job.data?.stage, job.data, productId, queryClient]);

  const start = (): void => {
    if (productId === null || env === null) return;
    setError(null);
    void startCapture(productId, env.id)
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: ["snapshot-job", productId],
        }),
      )
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "启动失败");
      });
  };
  const stop = (): void => {
    if (productId === null) return;
    void cancelCapture(productId)
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: ["snapshot-job", productId],
        }),
      )
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "停止失败");
      });
  };

  if (usable.length === 0)
    return (
      <div className="sn-capture">
        <span className="muted small">
          这个产品还没登记测试环境。先到「产品 →
          测试环境」登记地址与账号，再把页面采下来存成快照。
        </span>
      </div>
    );

  const j = job.data;
  return (
    <div className="sn-capture">
      <Select
        className="input sm"
        aria-label="采集哪个环境"
        value={env?.id ?? ""}
        options={usable.map((e) => ({
          value: e.id,
          label: `${e.baseUrl}${e.role === "" ? "" : `（${e.role}）`}`,
        }))}
        onChange={(v) => setEnvId(v)}
      />
      {running ? (
        <>
          <span className="small">
            <Loader2 size={13} className="spin" />{" "}
            {j?.stage === "login"
              ? "登录中…"
              : `正在采第 ${String(j?.done ?? 0)} / ${String(j?.total ?? 0)} 页…`}
          </span>
          <button type="button" className="btn small danger" onClick={stop}>
            停止
          </button>
          <span className="muted small">
            采集在服务端跑，可以切走，回来接着看。
          </span>
        </>
      ) : (
        <button
          type="button"
          className="btn small primary"
          disabled={productId === null}
          onClick={start}
        >
          <Camera size={13} /> 采集这一版
        </button>
      )}
      {j?.stage === "cancelled" && (
        <span className="muted small">上次采集已停止（没有生成快照）。</span>
      )}
      {j?.stage === "failed" && j.error !== null && (
        <span className="err-text small">采集失败：{j.error}</span>
      )}
      {error !== null && <span className="err-text small">{error}</span>}
    </div>
  );
}

function Body({
  productName,
  versions,
  current,
  loading,
  onPick,
}: {
  productName: string | null;
  versions: Snapshot[];
  current: Snapshot | null;
  loading: boolean;
  onPick: (id: string) => void;
}): React.JSX.Element {
  const [pagePath, setPagePath] = useState<string | null>(null);
  const page =
    current?.pages.find((p) => p.path === pagePath) ??
    current?.pages[0] ??
    null;

  if (loading)
    return (
      <div className="u-empty">
        <Loader2 size={20} className="spin faint" />
        <p className="muted small">读取中…</p>
      </div>
    );
  if (productName === null)
    return (
      <div className="u-empty">
        <Camera size={28} className="faint" />
        <p>还没有产品</p>
      </div>
    );
  if (versions.length === 0)
    return (
      <div className="u-empty">
        <RefreshCw size={28} className="faint" />
        <p>「{productName}」还没有任何页面快照</p>
        <p className="muted small">
          上面选一个测试环境，点「采集这一版」：浏览器会真打开每一页，存下截图和页面文字，
          并记下这一版对应的提交 / 分支 / PR。
        </p>
      </div>
    );

  return (
    <div className="sn-body">
      <aside className="sn-versions" aria-label="版本">
        {versions.map((v) => (
          <button
            key={v.id}
            type="button"
            className={v.id === current?.id ? "on" : ""}
            onClick={() => {
              onPick(v.id);
              setPagePath(null);
            }}
          >
            <strong>{v.version.tag ?? v.version.short ?? v.id}</strong>
            <span className="muted small">{v.label}</span>
            <span className="muted small">
              {new Date(v.capturedAt).toLocaleString()} ·{" "}
              {v.pages.filter((p) => p.status === "ok").length} 页可用
            </span>
          </button>
        ))}
      </aside>
      <div className="sn-pages">
        <ul>
          {current?.pages.map((p) => (
            <li key={p.path}>
              <button
                type="button"
                className={p.path === page?.path ? "on" : ""}
                onClick={() => setPagePath(p.path)}
              >
                <span className="sn-title">{p.title ?? p.path}</span>
                <code>{p.path}</code>
                <span className={`tag ${p.status === "ok" ? "" : "warn"}`}>
                  {STATUS_LABEL[p.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="sn-detail">
        {page === null ? (
          <p className="muted small">选一个页面</p>
        ) : (
          <>
            <header>
              <strong>{page.title ?? page.path}</strong>
              <code>{page.path}</code>
            </header>
            {page.image === null ? (
              <p className="muted small">{page.note ?? "这页没截成"}</p>
            ) : (
              <a href={shotUrl(page.image)} target="_blank" rel="noreferrer">
                <img
                  className="sn-shot"
                  src={shotUrl(page.image)}
                  alt={page.path}
                />
              </a>
            )}
            {page.note !== null && <p className="u-warn small">{page.note}</p>}
            {current !== null && <VersionFacts version={current.version} />}
          </>
        )}
      </div>
    </div>
  );
}

function VersionFacts({
  version,
}: {
  version: CodeVersion;
}): React.JSX.Element {
  return (
    <dl className="sn-facts">
      {version.commit === null ? (
        <>
          <dt>版本</dt>
          <dd>{version.unavailable ?? "读不到版本信息"}</dd>
        </>
      ) : (
        <>
          <dt>提交</dt>
          <dd>
            <code>{version.short}</code>
            {version.subject !== null && ` ${version.subject}`}
          </dd>
          <dt>分支</dt>
          <dd>
            {version.branch ?? "（分离头指针）"}
            {version.dirty && " · 有本地改动"}
          </dd>
          {version.tag !== null && (
            <>
              <dt>标签</dt>
              <dd>{version.tag}</dd>
            </>
          )}
          {version.pr !== null && (
            <>
              <dt>PR</dt>
              <dd>#{version.pr}</dd>
            </>
          )}
        </>
      )}
    </dl>
  );
}
