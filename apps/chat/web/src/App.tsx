import { Suspense, lazy, useEffect, useRef, useState } from "react";
import {
  Bot,
  Boxes,
  Camera,
  ChevronDown,
  ClipboardList,
  FileText,
  FolderGit2,
  FolderOpen,
  Inbox,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  LayoutTemplate,
  ListTodo,
  Lightbulb,
  SquareKanban,
  Search,
  Settings,
  Presentation,
  Sparkles,
  Sun,
  LayoutDashboard,
  Radar,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { createSession, isForgeSession, listSessions } from "./api";
import { CommandPalette, type Command } from "./shell/CommandPalette";
import {
  THEME_LABEL,
  THEMES,
  setTheme,
  useTheme,
  type Theme,
} from "./settings/theme";

import { ChatPage } from "./chat/ChatPage";
import { StagingPage } from "./staging/StagingPage";
import { IntelPage } from "./intel/IntelPage";
import { STAGING_QUERY_KEY, getStaging } from "./staging/api";
import { FillPage } from "./fill/FillPage";
import { GlobalFillDialog } from "./fill/GlobalFillDialog";
import { getCurrentRun } from "./fill/api";
import { CodeReposPage } from "./code/CodeReposPage";
import { FilesPage } from "./files/FilesPage";
import {
  CODE_HOME,
  CODE_ROOT,
  FILES_HOME,
  type FilesLocation,
} from "./files/location";
import { LifecyclePage } from "./lifecycle/LifecyclePage";
import { listLines } from "./products/api";
import { PresalesPage } from "./presales/PresalesPage";
import { PresalesTemplatesPage } from "./presales/PresalesTemplatesPage";
import { ProductsPage } from "./products/ProductsPage";
import { UiPagesPage } from "./ui-pages/UiPagesPage";
import { WorkPage } from "./work/WorkPage";
import { HomePage } from "./home/HomePage";
import { BrandMark } from "./shell/BrandMark";
import { RailTip } from "./shell/RailTip";

/** 图谱带着 React Flow（约 220 KB），单独分块：只在真点进「图谱」标签时才下载。 */
const GraphPage = lazy(() => import("./graph/GraphPage"));
const SchemaPage = lazy(() => import("./schema/SchemaPage"));
const SnapshotsPage = lazy(() => import("./snapshots/SnapshotsPage"));
/*
 * Wiki 页懒加载：它带着 react-markdown + remark-gfm 那一串（压缩后约 120 KB），
 * 而大多数会话根本不会打开它。与图谱页同一个理由。
 */
const WikiPageView = lazy(() =>
  import("./wiki/WikiPageView").then((m) => ({ default: m.WikiPageView })),
);
import {
  DefaultsSettings,
  ProvidersSettings,
} from "./settings/ProvidersSettings";
import { AccountSettings } from "./auth/AuthGate";
import { InterfaceSettings } from "./settings/InterfaceSettings";
import { PiSettings } from "./settings/PiSettings";
import { CodeSyncSettings } from "./settings/CodeSyncSettings";
import { SkillsPage } from "./skills/SkillsPage";
import { AgentsPage } from "./agents/AgentsPage";

/**
 * 外壳：左侧品牌导航（一级菜单）+ 右侧顶栏与当前菜单的页面。
 *
 * 骨架与视觉参考了一个内部运维控制台：
 * 256px 白底侧栏 = 品牌行 + 分组导航，右侧 64px 顶栏，主区画布用 gray-50。
 * 品牌行与顶栏同高，两条底边连成一条横线——这是参考的运维控制台最显眼的那条结构特征。
 *
 * 一级菜单之间互不依赖（对话不知道产品，产品不知道对话），外壳只负责切换。
 * 当前菜单记在 URL hash（#chat / #staging / #work / #products / #files / #skills / #agents / #settings）：刷新不丢，也能直接链接到某个菜单。
 */
type Menu =
  | "home"
  | "chat"
  | "staging"
  | "work"
  | "products"
  | "presales"
  | "files"
  | "snapshots"
  | "skills"
  | "agents"
  | "intel"
  | "settings";

interface MenuItem {
  id: Menu;
  label: string;
  icon: React.ReactNode;
}

/** 分组顺序即侧栏渲染顺序；分组标题是标签而非按钮，不干扰键盘导航。 */
const SECTIONS: readonly { name: string; items: readonly MenuItem[] }[] = [
  {
    name: "工作台",
    items: [
      // 控制台：打开系统的第一屏。各模块的数字、趋势与最近动态汇在一页，
      // 点哪块就去哪个模块——它只读不写，不替代任何一个模块。
      { id: "home", label: "控制台", icon: <LayoutDashboard size={18} /> },
      { id: "chat", label: "对话", icon: <MessagesSquare size={18} /> },
      // 临时区：所有待确认的 AI 产出。紧跟对话：
      // 对话里存下的东西下一步就是来这里确认。
      { id: "staging", label: "临时区", icon: <Inbox size={18} /> },
      // 任务与需求：想法的入口。用户需求随手记，内部任务从 Linear 等拉进来，
      // 两边都能一键开对话——所以排在对话 / 临时区之后、产品之前。
      { id: "work", label: "任务与需求", icon: <ListTodo size={18} /> },
      { id: "products", label: "产品", icon: <Boxes size={18} /> },
      // 售前材料：按产品 × 销售阶段组织的出货物料。与「产品」的分工是
      // 前者管产品本身与生命周期，这儿管对外用的白皮书、PPT、报价单各是哪一版。
      { id: "presales", label: "售前材料", icon: <Presentation size={18} /> },
    ],
  },
  {
    name: "资料",
    items: [
      { id: "files", label: "事实底座", icon: <FolderOpen size={18} /> },
      // 页面快照库：浏览器真实渲染的页面，按版本留档。与文件库（人写的）、
      // 代码库（源码）并列，是事实底座的第三处依据。
      { id: "snapshots", label: "页面快照", icon: <Camera size={18} /> },
      // 市场情报：竞品、市场、行业动态、合规等外部资料。
      // 放在事实底座之后：两者都是 AI 的资料，但情报是「参考」，事实底座是「依据」。
      { id: "intel", label: "市场情报", icon: <Radar size={18} /> },
      { id: "skills", label: "技能", icon: <Sparkles size={18} /> },
      // 技能是操作手册，执行体是照手册干活、配好工具权限的人。两者是组合关系
      // 不是升级关系，所以并列成两个入口而不是塞进技能页当一个标签。
      { id: "agents", label: "执行体", icon: <Bot size={18} /> },
    ],
  },
  {
    name: "系统",
    items: [{ id: "settings", label: "设置", icon: <Settings size={18} /> }],
  },
];

const MENU_IDS = new Set<Menu>(
  SECTIONS.flatMap((s) => s.items.map((i) => i.id)),
);

const THEME_ICON: Record<Theme, React.ReactNode> = {
  light: <Sun size={14} />,
  system: <Monitor size={14} />,
  dark: <Moon size={14} />,
};

const NARROW_KEY = "pmforge-chat.rail-narrow";
/** 默认收成图标栏（鼠标停留显示名字）；只有人主动展开过（存了 "0"）才显示文字。 */
const readNarrow = (): boolean => {
  try {
    return localStorage.getItem(NARROW_KEY) !== "0";
  } catch {
    return true;
  }
};

/**
 * 二级菜单（标签栏）。同一个一级菜单下的兄弟页面，渲染在顶栏下方——骨架照参考的运维控制台
 * （它的 default.vue 用 `meta.nav.tabOf` 在 header 下渲染同组兄弟页）。
 *
 * 空字符串是该菜单的默认页，hash 形如 `#products`；带 id 的形如 `#products/lifecycle`。
 * 没有标签的菜单整行不渲染，不留空白条。
 */
interface Tab {
  id: string;
  label: string;
}
const MENU_TABS: Partial<Record<Menu, readonly Tab[]>> = {
  files: [
    { id: "", label: "文件库" },
    { id: "code", label: "代码库" },
  ],
  work: [
    { id: "", label: "用户需求" },
    { id: "tasks", label: "内部任务" },
  ],
  presales: [
    { id: "", label: "材料清单" },
    { id: "templates", label: "售前模板" },
  ],
  products: [
    { id: "", label: "产品" },
    { id: "graph", label: "图谱" },
    { id: "schema", label: "数据结构" },
    { id: "pages", label: "页面" },
    { id: "wiki", label: "Wiki" },
    { id: "lifecycle", label: "生命周期规范" },
    { id: "fill", label: "AI 补齐" },
  ],
};

/**
 * 二级菜单画在左侧菜单里（缩进在一级菜单下面）而不是顶部标签栏的那些菜单。
 *
 * 事实底座的「文件库 / 代码库」是两套各管各的东西（文档 vs 仓库），不是同一个页面的
 * 两个视角，所以做成导航里的两个去处；产品下的四个标签是同一组数据的不同看法，留在顶部。
 */
const RAIL_SUBMENU: Partial<
  Record<Menu, Partial<Record<string, React.ReactNode>>>
> = {
  files: {
    "": <FileText size={16} />,
    code: <FolderGit2 size={16} />,
  },
  // 任务与需求同理：需求是人手记的，任务只从外部系统拉、只读，来源和用法都不同。
  work: {
    "": <Lightbulb size={16} />,
    tasks: <SquareKanban size={16} />,
  },
  // 售前同理：材料清单是「实际有什么」，售前模板是「标准该有什么」，两套各管各的数据。
  presales: {
    "": <ClipboardList size={16} />,
    templates: <LayoutTemplate size={16} />,
  },
};

const SUBMENU_KEY = "pmforge-chat.rail-collapsed";
const readCollapsed = (): ReadonlySet<string> => {
  try {
    return new Set(
      (localStorage.getItem(SUBMENU_KEY) ?? "").split(",").filter(Boolean),
    );
  } catch {
    return new Set();
  }
};

/** hash 拆成「一级菜单 / 二级标签」两段。认不出的标签退回该菜单的默认页。 */
const routeFromHash = (): { menu: Menu; tab: string } => {
  const [first = "", second = ""] = window.location.hash.slice(1).split("/");
  const menu = MENU_IDS.has(first as Menu) ? (first as Menu) : "home";
  const tabs = MENU_TABS[menu] ?? [];
  const tab = tabs.some((t) => t.id === second) ? second : "";
  return { menu, tab };
};

const hashOf = (menu: Menu, tab: string): string =>
  tab === "" ? `#${menu}` : `#${menu}/${tab}`;

export function App(): React.JSX.Element {
  const [route, setRoute] = useState(routeFromHash);
  const { menu, tab } = route;
  /** 浏览器标签页标题跟着当前菜单走，多开几个标签也分得清。 */
  useEffect(() => {
    const label = SECTIONS.flatMap((s) => s.items).find(
      (m) => m.id === menu,
    )?.label;
    document.title = label ? `${label} · PmForge` : "PmForge";
  }, [menu]);
  /** 对话菜单里打开的会话。放在外壳：切到别的菜单再回来，仍停在原会话。 */
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** 文件菜单的位置（当前文件夹、打开的文件）。同样放在外壳：切走再回来不丢。 */
  const [filesLocation, setFilesLocation] = useState<FilesLocation>(FILES_HOME);
  /** 「代码」入口自己记位置：它和「文件」是同一个库的两个入口，各看各的那一层。 */
  const [codeLocation, setCodeLocation] = useState<FilesLocation>(CODE_HOME);
  /**
   * 事实底座里有未保存的编辑。放在外壳：切菜单与切标签都归外壳管，
   * 页面自己拦不住（它会被直接卸载，而 beforeunload 在 SPA 内部导航不触发）。
   */
  const dirtyFiles = useRef(false);
  /**
   * 刚由「产品」里的 AI 分析建出来、还没发出去的那段提示词。
   *
   * 分析跑在真对话里，所以这里只做一件事：把人带到那条会话上，把提示词交给 ChatView
   * 发一次。发完就清掉——否则切走再回来会再发一遍。
   */
  /**
   * 产品页点某个产品后，图谱 / Wiki 要打开的那个产品。
   * 只做「带过去一次」：进了目标页就由那一页自己管选中。
   */
  const [productFocus, setProductFocus] = useState<{
    id: string;
    tab: "graph" | "wiki" | "schema" | "pages";
  } | null>(null);
  const [pendingAnalysis, setPendingAnalysis] = useState<{
    sessionId: string;
    prompt: string;
  } | null>(null);
  /** 比对类分析的横幅要显示产品名。产品清单在这里取，不让对话模块去依赖产品模块。 */
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  const productNameOf = (productId: string): string | undefined =>
    (lines.data ?? [])
      .flatMap((l) => l.products)
      .find((p) => p.id === productId)?.name;

  // 浏览器前进 / 后退改了 hash：跟着切菜单。
  useEffect(() => {
    const onHash = (): void => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (next: Menu, nextTab = ""): void => {
    // 重复点当前位置不要往 history 里压重复条目，否则后退要按很多次。
    if (next === menu && nextTab === tab) return;
    if (
      dirtyFiles.current &&
      !window.confirm("事实底座里有未保存的修改，放弃吗？")
    )
      return;
    dirtyFiles.current = false;
    setRoute({ menu: next, tab: nextTab });
    // pushState 不触发 hashchange（这里已经 setRoute 了），后退时浏览器会触发。
    window.history.pushState(null, "", hashOf(next, nextTab));
  };

  const tabs = MENU_TABS[menu] ?? [];
  const theme = useTheme();
  const queryClient = useQueryClient();

  /** 一级菜单收成只剩图标。存本机：下次打开还是上次的宽窄。 */
  const [narrow, setNarrow] = useState(readNarrow);
  const railRef = useRef<HTMLElement>(null);
  const toggleNarrow = (): void => {
    setNarrow((v) => {
      try {
        localStorage.setItem(NARROW_KEY, v ? "0" : "1");
      } catch {
        // 存不下就只在本次生效。
      }
      return !v;
    });
  };

  /**
   * 会话清单与对话页共用同一个查询键：外壳只读，用来在菜单和状态条上显示
   * 「几个会话正在回答」，以及给命令面板列最近会话。回答中时 5 秒刷一次。
   */
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
    refetchInterval: (q) =>
      (q.state.data ?? []).some((x) => x.streaming) ? 5000 : false,
  });
  const streamingCount = (sessions.data ?? []).filter(
    (x) => x.streaming,
  ).length;
  /** 临时区待确认数：侧栏角标用。与临时区页同一个查询键，页面里处理完角标跟着变。 */
  const staging = useQuery({
    queryKey: STAGING_QUERY_KEY,
    queryFn: getStaging,
    refetchInterval: 30_000,
  });
  const stagingCount = staging.data?.items.length ?? 0;

  /** 服务健康：30 秒探一次。挂了顶栏和状态条立刻变红，比对话发不出去再猜原因强。 */
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error(String(res.status));
      return true;
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const online = health.data === true;

  /* 命令面板：⌘K / Ctrl+K 开关。 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 全局 AI 补齐的发起框（两步确认）。 */
  const [fillOpen, setFillOpen] = useState(false);
  /** 顶栏入口要显示「补齐中 3/20」：跑着时轮询，停了就不再问。 */
  const fillRun = useQuery({
    queryKey: ["global-fill-run"],
    queryFn: getCurrentRun,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });
  const activeFill = fillRun.data?.status === "running" ? fillRun.data : null;
  const fillRunning = activeFill !== null;
  const fillProgress =
    activeFill === null
      ? ""
      : `${String(
          activeFill.jobs.filter(
            (j) => j.status !== "queued" && j.status !== "running",
          ).length,
        )}/${String(activeFill.jobs.length)}`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands: Command[] = [
    ...SECTIONS.flatMap((s) =>
      s.items.flatMap((m) => {
        const subTabs = MENU_TABS[m.id];
        if (subTabs === undefined)
          return [
            {
              id: `go-${m.id}`,
              group: "前往",
              label: m.label,
              icon: m.icon,
              run: () => go(m.id),
            },
          ];
        return subTabs.map((t) => ({
          id: `go-${m.id}-${t.id}`,
          group: "前往",
          label: t.id === "" ? m.label : `${m.label} · ${t.label}`,
          icon: m.icon,
          run: () => go(m.id, t.id),
        }));
      }),
    ),
    {
      id: "new-session",
      group: "会话",
      label: "新对话",
      icon: <MessageSquarePlus size={16} />,
      run: () => {
        void createSession().then((created) => {
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          setSessionId(created.id);
          go("chat");
        });
      },
    },
    ...(sessions.data ?? [])
      .filter((x) => !isForgeSession(x))
      .slice(0, 8)
      .map((x) => ({
        id: `session-${x.id}`,
        group: "会话",
        label: x.title,
        icon: <MessagesSquare size={16} />,
        ...(x.streaming ? { hint: "回答中" } : {}),
        run: () => {
          setSessionId(x.id);
          go("chat");
        },
      })),
    {
      id: "global-fill",
      group: "AI",
      label: fillRunning ? "全局 AI 补齐：查看进度" : "全局 AI 补齐…",
      icon: <Sparkles size={16} />,
      run: () => {
        if (fillRunning) go("products", "fill");
        else setFillOpen(true);
      },
    },
    ...THEMES.map((t) => ({
      id: `theme-${t}`,
      group: "外观",
      label: `主题：${THEME_LABEL[t]}`,
      icon: THEME_ICON[t],
      ...(t === theme ? { hint: "当前" } : {}),
      run: () => setTheme(t),
    })),
  ];

  /** 收起了二级菜单的一级菜单（存本机）。 */
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleSub = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(SUBMENU_KEY, [...next].join(","));
      } catch {
        // 存不下就只在本次生效。
      }
      return next;
    });

  const item = (m: MenuItem) => {
    const sub = RAIL_SUBMENU[m.id];
    const subTabs = MENU_TABS[m.id];
    if (sub === undefined || subTabs === undefined) return plainItem(m);
    // 收起菜单（只剩图标）时父项本身不显示，子项总是摊开——否则窄态下点不到。
    const open = narrow || !collapsed.has(m.id);
    return (
      <div key={m.id} className={`rail-group${open ? " open" : ""}`}>
        <button
          type="button"
          className={`rail-item rail-parent${menu === m.id ? " has-active" : ""}`}
          aria-expanded={open}
          aria-label={m.label}
          onClick={() => toggleSub(m.id)}
        >
          {m.icon}
          <span>{m.label}</span>
          <ChevronDown size={14} className="rail-chevron" aria-hidden="true" />
        </button>
        {open &&
          subTabs.map((t) => {
            const active = menu === m.id && tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                className={`rail-item rail-sub${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={t.label}
                data-rail-tip={`${m.label} · ${t.label}`}
                onClick={() => go(m.id, t.id)}
              >
                {sub[t.id]}
                <span>{t.label}</span>
              </button>
            );
          })}
      </div>
    );
  };

  const plainItem = (m: MenuItem) => (
    <button
      key={m.id}
      type="button"
      className={`rail-item${menu === m.id ? " active" : ""}`}
      aria-current={menu === m.id ? "page" : undefined}
      aria-label={m.label}
      data-rail-tip={m.label}
      onClick={() => go(m.id)}
    >
      {m.icon}
      <span>{m.label}</span>
      {m.id === "chat" && streamingCount > 0 && (
        <em className="rail-badge" aria-hidden="true">
          <Loader2 size={12} className="spin" />
          {streamingCount}
        </em>
      )}
      {m.id === "staging" && stagingCount > 0 && (
        <em
          className="rail-badge staging-badge"
          aria-label={`${String(stagingCount)} 项待确认`}
        >
          {stagingCount}
        </em>
      )}
    </button>
  );

  return (
    <div className={`shell${narrow ? " narrow" : ""}`}>
      <aside className="rail" ref={railRef}>
        <div className="rail-brand">
          <span className="rail-logo" aria-hidden="true">
            <BrandMark size={18} />
          </span>
          <span className="rail-brand-text">
            <span className="rail-brand-name">PM-Forge</span>
          </span>
        </div>
        <nav className="rail-nav" aria-label="一级菜单">
          {SECTIONS.map((s) => (
            <div key={s.name} className="rail-section">
              <div className="rail-section-title">{s.name}</div>
              {s.items.map(item)}
            </div>
          ))}
        </nav>
        <div className="rail-foot">
          <button
            type="button"
            className="rail-collapse"
            onClick={toggleNarrow}
            aria-label={narrow ? "展开菜单" : "收起菜单"}
            data-rail-tip={narrow ? "展开菜单" : "收起菜单"}
          >
            {narrow ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
            <span>{narrow ? "展开菜单" : "收起菜单"}</span>
          </button>
        </div>
        <RailTip container={railRef} enabled={narrow} />
      </aside>
      <div className="shell-page">
        <header className="topbar">
          <div className="topbar-title">
            {/* 页面标题只出现一次：顶栏这个就是它。不再配一句说明——
                少字：页面是干嘛的应该一眼看出来，而不是读一行字才知道。 */}
            <h1 className="topbar-name">
              {RAIL_SUBMENU[menu] !== undefined
                ? tabs.find((t) => t.id === tab)?.label
                : SECTIONS.flatMap((s) => s.items).find((m) => m.id === menu)
                    ?.label}
            </h1>
          </div>
          <button
            type="button"
            className="cmdk"
            onClick={() => setPaletteOpen(true)}
            aria-label="搜索或跳转（⌘K）"
          >
            <Search size={14} />
            <span>搜索或跳转</span>
            <kbd>⌘K</kbd>
          </button>
          <button
            type="button"
            className={`topbar-ai${fillRunning ? " running" : ""}`}
            aria-label={fillRunning ? "全局 AI 补齐进度" : "全局 AI 补齐"}
            title={
              fillRunning
                ? "全局 AI 补齐正在跑，点开看进度"
                : "借助事实底座给所有产品补齐缺的产出物与 Wiki（会先预览并二次确认）"
            }
            onClick={() => {
              if (fillRunning) go("products", "fill");
              else setFillOpen(true);
            }}
          >
            {fillRunning ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {fillRunning && <span className="label num">{fillProgress}</span>}
          </button>
          <span className="theme-seg" role="group" aria-label="主题">
            {(["light", "system", "dark"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={t === theme}
                aria-label={THEME_LABEL[t]}
                title={THEME_LABEL[t]}
                onClick={() => setTheme(t)}
              >
                {THEME_ICON[t]}
              </button>
            ))}
          </span>
        </header>
        {tabs.length > 0 && RAIL_SUBMENU[menu] === undefined && (
          <nav className="tabbar" aria-label="二级菜单">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tab${t.id === tab ? " active" : ""}`}
                aria-current={t.id === tab ? "page" : undefined}
                onClick={() => go(menu, t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
        )}
        <div className="shell-body">
          {/* 换页时整页淡入：key 跟着菜单与标签变，换一次播一次。 */}
          <div className="page-enter" key={`${menu}/${tab}`}>
            {menu === "home" && (
              <HomePage
                go={(m, t) => go(m as Menu, t)}
                onOpenSession={(id) => {
                  setSessionId(id);
                  go("chat");
                }}
                onNewChat={() => {
                  void createSession().then((created) => {
                    void queryClient.invalidateQueries({
                      queryKey: ["sessions"],
                    });
                    setSessionId(created.id);
                    go("chat");
                  });
                }}
              />
            )}
            {menu === "chat" && (
              <ChatPage
                sessionId={sessionId}
                onOpen={setSessionId}
                autoSend={pendingAnalysis ?? undefined}
                onAutoSent={() => setPendingAnalysis(null)}
                productNameOf={productNameOf}
              />
            )}
            {menu === "intel" && (
              <IntelPage
                onOpenSession={(id) => {
                  setSessionId(id);
                  go("chat");
                }}
              />
            )}
            {menu === "staging" && (
              <StagingPage
                onOpenSession={(id) => {
                  setSessionId(id);
                  go("chat");
                }}
                onOpenFolder={(folder, file) => {
                  setFilesLocation({ folder, file });
                  go("files");
                }}
              />
            )}
            {menu === "work" && (
              <WorkPage
                key={tab}
                kind={tab === "tasks" ? "task" : "request"}
                onStartChat={(started) => {
                  setPendingAnalysis(started);
                  setSessionId(started.sessionId);
                  go("chat");
                }}
                onOpenSession={(id) => {
                  setSessionId(id);
                  go("chat");
                }}
              />
            )}
            {menu === "products" && tab === "" && (
              <ProductsPage
                onAnalysis={(started) => {
                  setPendingAnalysis(started);
                  setSessionId(started.sessionId);
                  go("chat");
                }}
                onOpenProduct={(product, target) => {
                  const tab =
                    target === "wiki" ||
                    target === "schema" ||
                    target === "pages"
                      ? target
                      : "graph";
                  setProductFocus({ id: product.id, tab });
                  go("products", tab);
                }}
                onChat={(product) => {
                  // 带上 productId：这条对话会按该产品的依据库注入事实依据。
                  void createSession({ productId: product.id }).then(
                    (created) => {
                      void queryClient.invalidateQueries({
                        queryKey: ["sessions"],
                      });
                      setSessionId(created.id);
                      go("chat");
                    },
                  );
                }}
              />
            )}
            {menu === "presales" && tab === "" && (
              <PresalesPage
                onOpenSession={(id) => {
                  setSessionId(id);
                  go("chat");
                }}
              />
            )}
            {menu === "presales" && tab === "templates" && (
              <PresalesTemplatesPage />
            )}
            {menu === "products" && tab === "lifecycle" && <LifecyclePage />}
            {menu === "products" && tab === "fill" && (
              <FillPage
                onLaunch={() => setFillOpen(true)}
                onOpenSession={(id) => {
                  setSessionId(id);
                  go("chat");
                }}
              />
            )}
            {menu === "products" && tab === "graph" && (
              <Suspense
                fallback={
                  <p className="muted small pad">
                    <Loader2 size={14} className="spin" /> 加载图谱…
                  </p>
                }
              >
                <GraphPage
                  onAnalysis={(started) => {
                    setPendingAnalysis(started);
                    setSessionId(started.sessionId);
                    go("chat");
                  }}
                  {...(productFocus?.tab === "graph"
                    ? { productId: productFocus.id }
                    : {})}
                />
              </Suspense>
            )}
            {menu === "products" && tab === "schema" && (
              <Suspense
                fallback={
                  <p className="muted small pad">
                    <Loader2 size={14} className="spin" /> 加载数据结构…
                  </p>
                }
              >
                <SchemaPage
                  {...(productFocus?.tab === "schema"
                    ? { productId: productFocus.id }
                    : {})}
                />
              </Suspense>
            )}
            {menu === "products" && tab === "pages" && (
              <UiPagesPage
                {...(productFocus?.tab === "pages"
                  ? { productId: productFocus.id }
                  : {})}
                onOpenFile={(path) => {
                  // 组件源文件在代码库里：带到「事实底座 → 代码库」打开它。
                  setCodeLocation({
                    folder: path.slice(0, path.lastIndexOf("/")),
                    file: path,
                  });
                  go("files", "code");
                }}
              />
            )}
            {menu === "products" && tab === "wiki" && (
              <Suspense
                fallback={
                  <p className="muted small pad">
                    <Loader2 size={14} className="spin" /> 加载 Wiki…
                  </p>
                }
              >
                <WikiPageView
                  onAnalysis={(started) => {
                    setPendingAnalysis(started);
                    setSessionId(started.sessionId);
                    go("chat");
                  }}
                  {...(productFocus?.tab === "wiki"
                    ? { productId: productFocus.id }
                    : {})}
                />
              </Suspense>
            )}
            {menu === "snapshots" && (
              <Suspense
                fallback={
                  <p className="muted small pad">
                    <Loader2 size={14} className="spin" /> 加载页面快照…
                  </p>
                }
              >
                <SnapshotsPage />
              </Suspense>
            )}
            {menu === "files" && tab === "" && (
              <FilesPage
                location={filesLocation}
                onLocation={setFilesLocation}
                rootName="文件库"
                hide={[CODE_ROOT]}
                onDirtyChange={(d) => (dirtyFiles.current = d)}
              />
            )}
            {menu === "files" && tab === "code" && (
              <CodeReposPage
                location={codeLocation}
                onLocation={setCodeLocation}
                onDirtyChange={(d) => (dirtyFiles.current = d)}
              />
            )}
            {/* 技能页自己是「左列表 + 右展览」的满高布局，不套 settings-page 的滚动容器。 */}
            {menu === "skills" && <SkillsPage />}
            {menu === "agents" && <AgentsPage />}
            {menu === "settings" && (
              <div className="settings-page">
                <div className="settings">
                  {/* 页面标题在顶栏，这里不再重复「设置」二字。 */}
                  <AccountSettings />
                  <ProvidersSettings />
                  <DefaultsSettings />
                  <InterfaceSettings />
                  <CodeSyncSettings />
                  <PiSettings />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <footer className="statusbar" aria-label="状态">
        <span className="statusbar-item">
          <i
            style={{
              background: health.isError
                ? "var(--danger)"
                : online
                  ? "var(--ok)"
                  : "var(--faint)",
            }}
          />
          {health.isError
            ? "对话服务 · 未连接"
            : online
              ? "对话服务 · 已连接"
              : "对话服务 · 检查中"}
        </span>
        <span className="statusbar-right">
          {streamingCount > 0 && (
            <span className="statusbar-item">
              <i style={{ background: "var(--ai)" }} />
              {streamingCount} 个会话回答中
            </span>
          )}
          <span className="statusbar-item wide-only">
            会话{" "}
            {(sessions.data ?? []).filter((x) => !isForgeSession(x)).length}
          </span>
          <span className="statusbar-item wide-only">
            主题 {THEME_LABEL[theme]}
          </span>
        </span>
      </footer>
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {fillOpen && (
        <GlobalFillDialog
          onClose={() => setFillOpen(false)}
          onStarted={() => {
            setFillOpen(false);
            go("products", "fill");
          }}
          onOpenProgress={() => {
            setFillOpen(false);
            go("products", "fill");
          }}
        />
      )}
    </div>
  );
}
