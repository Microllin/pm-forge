import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Boxes,
  FileText,
  Inbox,
  Lightbulb,
  MessageSquarePlus,
  MessagesSquare,
  SquareKanban,
  TrendingUp,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { isForgeSession, listSessions } from "../api";
import { listLines } from "../products/api";
import { STAGING_QUERY_KEY, getStaging } from "../staging/api";
import {
  LINEAR_KEY,
  getLinear,
  listWorkItems,
  workKey,
  type WorkItem,
} from "../work/api";
import {
  CountUp,
  DotGrid,
  Donut,
  MiniBars,
  Ring,
  Sparkline,
  TrendChart,
} from "./charts";
import "./home.css";

/**
 * 控制台：打开系统的第一屏。
 *
 * 只读、只汇总：数字、趋势、分布、最近动态都来自各模块现成的接口（和各模块页
 * 共用同一个查询键，所以不会多请求一遍），点哪块就跳到哪个模块去处理。
 * 少字：能用数字和图说的不写句子；每块只有一个短标题。
 */

const DAY = 86_400_000;
const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** 最近 n 天（含今天）每天各有多少条。 */
const perDay = (times: readonly number[], n: number, now: number): number[] => {
  const today = startOfDay(now);
  const out = Array.from({ length: n }, () => 0);
  for (const t of times) {
    const idx = n - 1 - Math.round((today - startOfDay(t)) / DAY);
    if (idx >= 0 && idx < n) out[idx] = (out[idx] ?? 0) + 1;
  }
  return out;
};
const dayLabels = (n: number, now: number): string[] => {
  const today = startOfDay(now);
  return Array.from({ length: n }, (_, i) => {
    if (i === n - 1) return "今天";
    const d = new Date(today - (n - 1 - i) * DAY);
    return `${String(d.getMonth() + 1)}/${String(d.getDate())}`;
  });
};
const ago = (ms: number, now: number): string => {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${String(Math.floor(s / 60))} 分钟前`;
  if (s < 86400) return `${String(Math.floor(s / 3600))} 小时前`;
  if (s < 86400 * 30) return `${String(Math.floor(s / 86400))} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN");
};
const isOpen = (w: WorkItem): boolean =>
  w.status === "todo" || w.status === "doing";

export function HomePage({
  go,
  onOpenSession,
  onNewChat,
}: {
  go: (menu: string, tab?: string) => void;
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
}): React.JSX.Element {
  // 「现在」在打开控制台那一刻定下来：渲染中不能随手取时钟（结果会每次不同）。
  const [now] = useState(() => Date.now());
  const sessionsQ = useQuery({ queryKey: ["sessions"], queryFn: listSessions });
  const stagingQ = useQuery({
    queryKey: STAGING_QUERY_KEY,
    queryFn: getStaging,
  });
  const requestsQ = useQuery({
    queryKey: workKey("request"),
    queryFn: () => listWorkItems("request"),
  });
  const tasksQ = useQuery({
    queryKey: workKey("task"),
    queryFn: () => listWorkItems("task"),
  });
  const linearQ = useQuery({ queryKey: LINEAR_KEY, queryFn: getLinear });
  const linesQ = useQuery({ queryKey: ["lines"], queryFn: listLines });

  const loading =
    sessionsQ.isLoading ||
    stagingQ.isLoading ||
    requestsQ.isLoading ||
    tasksQ.isLoading;

  const sessions = useMemo(
    () => (sessionsQ.data ?? []).filter((s) => !isForgeSession(s)),
    [sessionsQ.data],
  );
  const requests = useMemo(() => requestsQ.data ?? [], [requestsQ.data]);
  const tasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);
  const staging = useMemo(() => stagingQ.data?.items ?? [], [stagingQ.data]);
  const work = useMemo(() => [...requests, ...tasks], [requests, tasks]);

  const openRequests = requests.filter(isOpen);
  const newRequests7 = requests.filter(
    (r) => r.createdAt > now - 7 * DAY,
  ).length;
  const openTasks = tasks.filter(isOpen);
  const doingTasks = tasks.filter((t) => t.status === "doing");
  const stale = staging.filter((s) => s.createdAt < now - 2 * DAY).length;
  const sessions7 = perDay(
    sessions.map((s) => s.createdAt),
    7,
    now,
  );
  const sessionsWeek = sessions7.reduce((a, b) => a + b, 0);

  const days = dayLabels(14, now);
  const trendChats = perDay(
    sessions.map((s) => s.createdAt),
    14,
    now,
  );
  const trendWork = perDay(
    work.map((w) => w.createdAt),
    14,
    now,
  );

  const statusParts = [
    {
      name: "进行中",
      value: work.filter((w) => w.status === "doing").length,
      tone: "a",
    },
    {
      name: "待处理",
      value: work.filter((w) => w.status === "todo").length,
      tone: "b",
    },
    {
      name: "已完成",
      value: work.filter((w) => w.status === "done").length,
      tone: "c",
    },
    {
      name: "已取消",
      value: work.filter((w) => w.status === "canceled").length,
      tone: "d",
    },
  ];

  const byProduct = useMemo(() => {
    const names = new Map<string, string>();
    for (const l of linesQ.data ?? [])
      for (const p of l.products) names.set(p.id, p.name);
    const counts = new Map<string, number>();
    for (const w of work.filter(isOpen)) {
      const k = w.productId ?? "";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, n]) => ({
        id,
        name: id === "" ? "未关联" : (names.get(id) ?? "已删除的产品"),
        n,
      }))
      .sort((a, b) => (a.id === "" ? 1 : b.id === "" ? -1 : b.n - a.n))
      .slice(0, 6);
  }, [work, linesQ.data]);
  const productMax = Math.max(1, ...byProduct.map((p) => p.n));
  const productCount = (linesQ.data ?? []).reduce(
    (s, l) => s + l.products.length,
    0,
  );

  /** 最近动态：对话与待确认产出混排，按时间倒序。 */
  const feed = useMemo(() => {
    const items: {
      key: string;
      icon: React.ReactNode;
      text: string;
      at: number;
      run: () => void;
      live?: boolean;
    }[] = [
      ...sessions.map((s) => ({
        key: `s-${s.id}`,
        icon: <MessagesSquare size={15} />,
        text: s.title,
        at: s.updatedAt,
        run: () => onOpenSession(s.id),
        live: s.streaming,
      })),
      ...staging.map((x) => ({
        key: `d-${x.key}`,
        icon: <FileText size={15} />,
        text: `待确认 · ${x.title}`,
        at: x.createdAt,
        run: () => go("staging"),
      })),
    ];
    return items.sort((a, b) => b.at - a.at).slice(0, 7);
  }, [sessions, staging, onOpenSession, go]);

  const connected = linearQ.data?.connected === true;

  return (
    <div className="home">
      <div className="home-actions">
        <button type="button" className="btn primary" onClick={onNewChat}>
          <MessageSquarePlus size={15} />
          新对话
        </button>
        <button type="button" className="btn" onClick={() => go("work")}>
          <Lightbulb size={15} />
          记需求
        </button>
        <button type="button" className="btn" onClick={() => go("staging")}>
          <Inbox size={15} />
          去确认
          {staging.length > 0 && (
            <em className="home-count num">{staging.length}</em>
          )}
        </button>
      </div>

      <section className="home-kpis stagger" aria-label="关键数字">
        <button type="button" className="home-kpi" onClick={() => go("work")}>
          <span className="home-kpi-head">
            <Lightbulb size={15} />
            开放需求
            <ArrowUpRight size={13} className="home-kpi-go" />
          </span>
          <span className="home-kpi-value num">
            {loading ? (
              <span className="skeleton w-num" />
            ) : (
              <CountUp value={openRequests.length} />
            )}
            {newRequests7 > 0 && (
              <span className="home-delta up" title="最近 7 天新增">
                <TrendingUp size={12} />
                {newRequests7}
              </span>
            )}
          </span>
          <Sparkline
            data={perDay(
              requests.map((r) => r.createdAt),
              14,
              now,
            )}
            label="近 14 天每天新增需求"
          />
        </button>

        <button
          type="button"
          className="home-kpi"
          onClick={() => go("work", "tasks")}
        >
          <span className="home-kpi-head">
            <SquareKanban size={15} />
            Linear 任务
            <ArrowUpRight size={13} className="home-kpi-go" />
          </span>
          <span className="home-kpi-value num">
            {loading ? (
              <span className="skeleton w-num" />
            ) : (
              <CountUp value={doingTasks.length} />
            )}
            <span className="home-delta">/ {openTasks.length}</span>
          </span>
          {connected || tasks.length > 0 ? (
            <Ring
              value={doingTasks.length}
              total={openTasks.length}
              label={`进行中 ${String(doingTasks.length)} / 开放 ${String(openTasks.length)}`}
            />
          ) : (
            <span className="home-kpi-hint">未接入</span>
          )}
        </button>

        <button type="button" className="home-kpi" onClick={() => go("chat")}>
          <span className="home-kpi-head">
            <MessagesSquare size={15} />
            本周对话
            <ArrowUpRight size={13} className="home-kpi-go" />
          </span>
          <span className="home-kpi-value num">
            {loading ? (
              <span className="skeleton w-num" />
            ) : (
              <CountUp value={sessionsWeek} />
            )}
            <span className="home-delta">/ {sessions.length}</span>
          </span>
          <MiniBars data={sessions7} label="近 7 天每天新开对话" />
        </button>

        <button
          type="button"
          className="home-kpi"
          onClick={() => go("staging")}
        >
          <span className="home-kpi-head">
            <Inbox size={15} />
            待确认产出
            <ArrowUpRight size={13} className="home-kpi-go" />
          </span>
          <span className="home-kpi-value num">
            {loading ? (
              <span className="skeleton w-num" />
            ) : (
              <CountUp value={staging.length} />
            )}
            {stale > 0 && (
              <span className="home-delta warn" title="放了超过 2 天还没确认">
                {stale} 超 2 天
              </span>
            )}
          </span>
          <DotGrid
            total={staging.length}
            warn={stale}
            label={`${String(staging.length)} 份待确认，${String(stale)} 份超过 2 天`}
          />
        </button>
      </section>

      <section className="home-row two">
        <div className="home-card">
          <header>
            <h3>近 14 天</h3>
            <span className="home-legend">
              <i className="tone-a" />
              对话
              <i className="tone-b" />
              需求与任务
            </span>
          </header>
          <TrendChart
            days={days}
            label="近 14 天每天新开的对话数，以及新增的需求与任务数"
            series={[
              { name: "需求与任务", data: trendWork, tone: "b" },
              { name: "对话", data: trendChats, tone: "a" },
            ]}
          />
        </div>
        <div className="home-card">
          <header>
            <h3>需求与任务状态</h3>
          </header>
          <div className="home-donut">
            <Donut parts={statusParts} unit="条" label="需求与任务的状态分布" />
            <ul>
              {statusParts.map((p) => (
                <li key={p.name}>
                  <i className={`tone-${p.tone}`} />
                  {p.name}
                  <b className="num">{p.value}</b>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="home-row three">
        <div className="home-card">
          <header>
            <h3>开放项 · 按产品</h3>
            <button
              type="button"
              className="home-link"
              onClick={() => go("products")}
            >
              <Boxes size={13} />
              <span className="num">{productCount}</span>
            </button>
          </header>
          {byProduct.length === 0 ? (
            <p className="home-empty">还没有开放的需求或任务</p>
          ) : (
            <ul className="home-bars">
              {byProduct.map((p, i) => (
                <li key={p.id}>
                  <span className="home-bar-name" title={p.name}>
                    {p.name}
                  </span>
                  <span className="home-bar-track">
                    <span
                      className={`home-bar-fill grow-x${p.id === "" ? " dim" : ""}`}
                      style={{
                        width: `${String((p.n / productMax) * 100)}%`,
                        animationDelay: `${String(i * 60)}ms`,
                      }}
                    />
                  </span>
                  <b className="num">{p.n}</b>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="home-card span-2">
          <header>
            <h3>最近动态</h3>
          </header>
          {feed.length === 0 ? (
            <p className="home-empty">还没有对话或待确认的产出</p>
          ) : (
            <ul className="home-feed stagger">
              {feed.map((f) => (
                <li key={f.key}>
                  <button type="button" onClick={f.run}>
                    <span className={`home-feed-icon${f.live ? " live" : ""}`}>
                      {f.icon}
                    </span>
                    <span className="home-feed-text">{f.text}</span>
                    <time className="num">
                      {f.live ? "回答中" : ago(f.at, now)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
