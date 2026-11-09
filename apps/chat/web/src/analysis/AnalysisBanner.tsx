import { useState } from "react";
import {
  BookOpen,
  Boxes,
  ClipboardCheck,
  Code2,
  FileSearch,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listTemplates } from "../lifecycle/api";
import {
  applyArchitecture,
  applyDiscovered,
  applyWikiOutline,
  applyWikiPage,
  readResult,
  saveCheck,
  type ApplyLine,
} from "./api";
import {
  ArchitectureReview,
  CompareReport,
  DiscoverReview,
  WikiOutlineReview,
  WikiPageReview,
} from "./panels";
import "./analysis.css";

/** 会话上的分析任务标记（服务端 sessions.task）。 */
export type AnalysisTask =
  | {
      kind: "discover";
      /** 第一处选中的路径（旧会话只有这一项）。 */
      folderPath: string;
      /** 本次勾选的全部路径：文档文件夹、单个文件、代码仓库。 */
      paths?: string[];
    }
  | {
      kind: "compare";
      productId: string;
      templateId: string;
      folderPath: string;
    }
  | {
      kind: "architecture";
      productId: string;
      nodeId: string | null;
      mode: "append" | "replace";
      codePath: string;
    }
  | {
      kind: "wiki-outline";
      productId: string;
      mode: "append" | "replace";
    }
  | { kind: "wiki-page"; productId: string; pageId: string }
  /** 售前材料的 AI 识别：从文件夹范围里挑文件，结果落成候选清单。 */
  | { kind: "presales-recognize"; libId: string; folderPath: string }
  /** 售前材料 AI 审阅 / 体系复盘的一步：结果由售前页取，这里不提供应用。 */
  | {
      kind: "presales-ai";
      libId: string;
      jobId: string;
      job: "ledger" | "cross" | "review";
    }
  /** 售前库的常驻助手：不是一次性分析，对话页不显示横幅（见 ChatPage）。 */
  | { kind: "presales-agent"; libId: string }
  /** 市场情报的 AI 调研：发现逐条进情报库的待确认，这里不提供应用。 */
  | { kind: "intel-research"; productId: string | null }
  /** AI 工坊（技能 / 智能体）：在技能、智能体页里用，不进对话列表（见 forge/）。 */
  | {
      kind: "forge";
      of: "skill" | "agent";
      mode: "create" | "edit" | "distill";
    }
  /** 全局 AI 补齐里的「起草一份缺的产出物」：结果自动进草稿区，这里不提供应用。 */
  | {
      kind: "fill-artifact";
      productId: string;
      runId: string;
      stageCode: string;
      artifact: string;
    };

/**
 * 分析会话顶部的横幅。
 *
 * 分析跑在真对话里，所以会话页本身就是过程；横幅只负责两件事：
 * ① 说清这条对话是一次什么分析、对着哪个目录；② 给一个「把结果取出来」的入口。
 *
 * **取结果是显式动作，不自动弹。** 回答结束 ≠ 用户认可了结果——他可能还要追问。
 * 自动弹窗会在他正读理由时挡住屏幕，而追问后又得再弹一次。
 */
export function AnalysisBanner({
  sessionId,
  task,
  productName,
  streaming,
}: {
  sessionId: string;
  task: AnalysisTask;
  productName?: string | undefined;
  streaming: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: ["lifecycle-templates"],
    queryFn: listTemplates,
    enabled: task.kind === "discover",
  });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof readResult>
  > | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setDone(null);
    try {
      setResult(await readResult(sessionId));
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取结果失败");
    }
    setLoading(false);
  };

  const apply = (lines: ApplyLine[]): void => {
    setBusy(true);
    setError(null);
    void applyDiscovered(sessionId, lines)
      .then(async (report) => {
        await queryClient.invalidateQueries({ queryKey: ["lines"] });
        const parts = [
          report.createdLines.length > 0
            ? `建了产品线 ${report.createdLines.join("、")}`
            : null,
          report.createdProducts.length > 0
            ? `产品 ${report.createdProducts.join("、")}`
            : null,
          (report.filledProducts ?? []).length > 0
            ? `给已有产品补了依据：${(report.filledProducts ?? []).join("、")}`
            : null,
          report.skipped.length > 0
            ? `跳过 ${String(report.skipped.length)} 项（${report.skipped
                .map((s) => `${s.what}：${s.why}`)
                .join("；")}）`
            : null,
        ].filter((p) => p !== null);
        setDone(parts.length > 0 ? parts.join("；") : "没有新建任何东西");
        setOpen(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "应用失败");
      })
      .finally(() => setBusy(false));
  };

  const applyTree = (): void => {
    setBusy(true);
    setError(null);
    void applyArchitecture(sessionId)
      .then(async (report) => {
        await queryClient.invalidateQueries({ queryKey: ["features"] });
        const parts = [
          report.created.length > 0
            ? `新增功能 ${report.created.join("、")}`
            : null,
          report.skipped.length > 0
            ? `跳过已存在的 ${report.skipped.join("、")}`
            : null,
        ].filter((p) => p !== null);
        setDone(parts.length > 0 ? parts.join("；") : "没有新增任何功能");
        setOpen(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "应用失败");
      })
      .finally(() => setBusy(false));
  };

  /** 应用目录。建完要让左栏章节树重新拉一次。 */
  const applyOutline = (): void => {
    setBusy(true);
    setError(null);
    void applyWikiOutline(sessionId)
      .then(async (report) => {
        await queryClient.invalidateQueries({ queryKey: ["wiki"] });
        const parts = [
          report.created.length > 0
            ? `建了 ${String(report.created.length)} 章：${report.created.join("、")}`
            : null,
          report.skipped.length > 0
            ? `跳过 ${report.skipped.join("；")}`
            : null,
          // 丢掉的精读路径要报：对应章节写正文时会缺这份料。
          (report.droppedSources ?? []).length > 0
            ? `${String(report.droppedSources?.length)} 条精读路径不在本产品的资料范围内或已不存在，已忽略（${(report.droppedSources ?? []).join("、")}）`
            : null,
        ].filter((p) => p !== null);
        setDone(parts.length > 0 ? parts.join("；") : "没有新增任何章节");
        setOpen(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "应用失败");
      })
      .finally(() => setBusy(false));
  };

  /** 应用正文。既要刷树（字数变了）也要刷这一页本身。 */
  const applyPage = (): void => {
    setBusy(true);
    setError(null);
    void applyWikiPage(sessionId)
      .then(async (report) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["wiki"] }),
          queryClient.invalidateQueries({
            queryKey: ["wiki-page", report.page.id],
          }),
        ]);
        setDone("正文已写进这一章，去「产品 → Wiki」看看");
        setOpen(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "应用失败");
      })
      .finally(() => setBusy(false));
  };

  const save = (): void => {
    setBusy(true);
    setError(null);
    void saveCheck(sessionId)
      .then(async (check) => {
        await queryClient.invalidateQueries({ queryKey: ["product-checks"] });
        setDone(
          `已存为最新比对结果：齐 ${String(check.summary.present)} · 不全 ${String(check.summary.partial)} · 缺 ${String(check.summary.missing)}`,
        );
        setOpen(false);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "保存失败");
      })
      .finally(() => setBusy(false));
  };

  /*
   * 标题 / 图标 / 按钮文案按任务种类分。
   *
   * 写成 switch 而不是嵌套三元：任务种类已经有五种，三元链到第四层就没人读得懂了，
   * 而且加一种时 TS 不会提醒你漏了分支——switch 的 never 兜底会。
   */
  const [label, icon, resultLabel] = ((): [
    string,
    React.JSX.Element,
    string,
  ] => {
    switch (task.kind) {
      case "discover":
        return ["AI 识别产线与产品", <Boxes size={15} />, "查看识别结果"];
      case "compare":
        return [
          `AI 比对产出物${productName === undefined ? "" : ` · ${productName}`}`,
          <ClipboardCheck size={15} />,
          "查看比对报告",
        ];
      case "architecture":
        return [
          task.nodeId === null
            ? "AI 分析功能架构"
            : task.mode === "replace"
              ? "AI 重新分析这一支功能"
              : "AI 向下拆一层功能",
          <Code2 size={15} />,
          "查看分析结果",
        ];
      case "wiki-outline":
        return [
          task.mode === "replace"
            ? "AI 重新规划 Wiki 目录"
            : "AI 规划 Wiki 目录",
          <BookOpen size={15} />,
          "查看目录方案",
        ];
      case "wiki-page":
        return ["AI 写 Wiki 正文", <BookOpen size={15} />, "查看正文"];
      case "presales-recognize":
        return ["AI 识别售前材料", <FileSearch size={15} />, "查看识别结果"];
      case "fill-artifact":
        return [
          `全局补齐 · 起草「${task.artifact}」`,
          <Sparkles size={15} />,
          "",
        ];
      case "presales-agent":
        return ["售前助手", <Sparkles size={15} />, ""];
      case "forge":
        return ["AI 工坊", <Sparkles size={15} />, ""];
      case "intel-research":
        return ["市场情报 · AI 调研", <Sparkles size={15} />, ""];
      case "presales-ai":
        return [
          task.job === "ledger"
            ? "售前复盘 · 抽口径台账"
            : task.job === "cross"
              ? "售前复盘 · 跨材料比对"
              : "售前材料 AI 审阅",
          <Sparkles size={15} />,
          "",
        ];
    }
  })();

  /**
   * 事实源那一行。wiki 的事实源是「文档目录 + 代码目录」两个，而 task 上没存
   * （存了也会和产品页上的绑定漂），所以这里只说取自哪里，具体路径在产品页看。
   */
  const sourceHint =
    task.kind === "architecture"
      ? task.codePath
      : task.kind === "wiki-outline" ||
          task.kind === "wiki-page" ||
          task.kind === "fill-artifact"
        ? "该产品绑定的文档目录与代码目录"
        : task.kind === "presales-ai" || task.kind === "presales-agent"
          ? "代码 > PRD > 路线图等资料（分层取自产品绑定的目录）"
          : task.kind === "discover"
            ? (task.paths ?? [task.folderPath]).join("、")
            : task.kind === "forge"
              ? "技能 / 智能体库与历史对话"
              : task.kind === "intel-research"
                ? "联网搜索与市场情报库"
                : task.folderPath;
  return (
    <>
      <div className="analysis-banner">
        <span className="analysis-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="analysis-text">
          <strong>{label}</strong>
          <span className="muted small">
            事实源 <code>{sourceHint}</code>
            {streaming
              ? " · 正在分析…"
              : task.kind === "fill-artifact"
                ? ""
                : task.kind === "presales-ai"
                  ? " · 追问后回「售前材料」页点「重新取结果」"
                  : task.kind === "presales-recognize"
                    ? " · 取结果只会落成候选清单，确认后才入库"
                    : " · 对结果不满意可以直接在下面追问，再取一次"}
          </span>
        </div>
        {task.kind === "fill-artifact" ? (
          // 全局补齐的这一步由服务端取结果、写进草稿区；在这里「应用」会绕过草稿审阅。
          <span className="muted small">草稿自动存进「产品 → AI 补齐」</span>
        ) : task.kind === "presales-ai" ? (
          // 修订清单要在售前页逐条采纳；在这里「应用」会绕过人的取舍。
          <span className="muted small">结果在「售前材料」页查看与采纳</span>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={streaming || loading}
            title={streaming ? "等它答完再取结果" : ""}
            onClick={() => void load()}
          >
            {loading ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Sparkles size={13} />
            )}
            {resultLabel}
          </button>
        )}
      </div>

      {error !== null && (
        <p className="analysis-note err-text" role="alert">
          {error}
        </p>
      )}
      {done !== null && (
        <p className="analysis-note ok-text" role="status">
          {done}
        </p>
      )}

      {open && result?.kind === "discover" && (
        <DiscoverReview
          result={result}
          templates={(templates.data ?? []).map((t) => ({
            id: t.id,
            name: t.name,
          }))}
          busy={busy}
          onApply={apply}
          onClose={() => setOpen(false)}
        />
      )}
      {open && result?.kind === "architecture" && (
        <ArchitectureReview
          result={result}
          busy={busy}
          onApply={applyTree}
          onClose={() => setOpen(false)}
        />
      )}
      {open && result?.kind === "wiki-outline" && (
        <WikiOutlineReview
          result={result}
          busy={busy}
          onApply={applyOutline}
          onClose={() => setOpen(false)}
        />
      )}
      {open && result?.kind === "wiki-page" && (
        <WikiPageReview
          result={result}
          busy={busy}
          onApply={applyPage}
          onClose={() => setOpen(false)}
        />
      )}
      {open && result?.kind === "compare" && (
        <CompareReport
          result={result}
          productName={productName ?? "这个产品"}
          busy={busy}
          onSave={save}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
