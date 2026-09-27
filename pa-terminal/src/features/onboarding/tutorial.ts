/// <reference types="vite/client" />
// ============================================================
// 使い方ツアー（スポットライト型）
//
// - 初回起動（session.json が無い）と、v1.0.0 より前から使っていた人の最初の起動
//   （保存データに tutorial が無い）で一度だけ、基本ツアーを流す。後者は導入カードを
//   「アップデートされました」の案内にする
// - 上部バーの「ツアー」からは一覧カードを開き、基本 / セッション分割 / 定型文 /
//   入力履歴・履歴 / Git・Worktree の各編を選んで見られる。見終えた編には ✓ を付ける
// - 導入・一覧・完了は画面中央のカード。各ステップは対象を切り抜き、次に押す場所を
//   動く矢印で指す。クリックは塞がない
//   - 操作ステップ（done あり）: 実際に操作したときだけ次へ進む（「次へ」は置かない）
//   - 説明ステップ（done なし）: ダイアログの中の各部を示し、「次へ」で進む
//   - needs が崩れたら（ダイアログを閉じた等）それを開くステップへ戻す
// - 初回のツアーを終えたとき（完了・スキップ・あとで）は一度だけ、上部バーの「ツアー」を
//   矢印で指して、ほかの機能の紹介がそこにあると知らせる
// - 対象の矩形は開いている間だけ短い間隔で測り直す。ツアー外では何も動かさない
// - ターミナルのフォーカスやキー入力は奪わない。Esc はカード内だけで受ける
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t, type MsgKey } from "../../i18n";
import { getActiveWs, getFocusedId, getHostOs, workspaces } from "../../workspace/state";
import { isLocked } from "../license/license";

type TutorialDeps = {
  /** 完了状態の保存（scheduleSave） */
  onChange: () => void;
};

export type TourId = "basics" | "view" | "phrases" | "history" | "git";
const TOUR_IDS: TourId[] = ["basics", "view", "phrases", "history", "git"];

/** いま操作してほしい場所。spot を切り抜き、arrow を矢印で指す。phase は段階つきの
    ステップ（チェックリスト）の何段目か */
type Task = { spot: Element[]; arrow: Element | null; phase?: number; prefer?: PointerSide[] };

/** ステップの開始時点の状態と、ステップ中に捕まえたクリック */
type Ctx = {
  workspaces: number;
  panes: number;
  cwd: string | undefined;
  phrases: number;
  clicked: boolean;
};

type StepDef = {
  id: string;
  /** 文言の接頭辞（.title / .body、try があれば .try） */
  key: string;
  icon: IconName;
  task: () => Task;
  /** 操作ステップ: 満たしたら次へ。無ければ説明ステップ（「次へ」で進む） */
  done?: (c: Ctx) => boolean;
  /** このステップの前提（ダイアログが開いている等）。崩れたら fallback のステップへ戻る */
  needs?: () => boolean;
  fallback?: string;
  /** 入った時点で当てはまれば飛ばす（前提がそろっている / 使えない環境） */
  skip?: () => boolean;
  /** クリックを捕まえて ctx.clicked を立てる対象（押すと消えるボタン用） */
  click?: string;
  try?: boolean;
  keys?: [MsgKey, string][];
  tasks?: MsgKey[];
};

type TourDef = { id: TourId; icon: IconName; back: boolean; steps: StepDef[] };

const TICK_MS = 120;
const GAP = 14;
const PAD = 6;

/** welcome = 初回インストール、update = v1.0.0 より前からの更新。null は表示済み */
export type TutorialMode = "welcome" | "update" | null;

let mode: TutorialMode = null;
let toursDone = new Set<TourId>();
let deps: TutorialDeps | undefined;
let running: { finish: (immediate?: boolean) => void } | undefined;

/** 保存値の読み込み（session.ts の boot） */
export function setTutorialMode(m: TutorialMode): void {
  mode = m;
}

export function getTutorialMode(): TutorialMode {
  return mode;
}

/** 見終えた編（一覧の ✓）。不正値は捨てる */
export function setToursDone(ids: unknown): void {
  toursDone = new Set(Array.isArray(ids) ? ids.filter((id): id is TourId => TOUR_IDS.includes(id)) : []);
}

export function getToursDone(): TourId[] {
  return TOUR_IDS.filter((id) => toursDone.has(id));
}

// ---- アイコン ----

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  session: ["M4 5.5h16v13H4z", "M12 9v6M9 12h6"],
  folder: ["M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2h8.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z", "M8 13h8M13 10l3 3-3 3"],
  split: ["M3.5 4.5h17v15h-17z", "M12 4.5v15", "M12 12h8.5"],
  done: ["M5 12.5l4.5 4.5L19 7.5"],
  compass: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M15.5 8.5l-2 5-5 2 2-5z"],
  view: ["M3 4h18v16H3z", "M12 4v16", "M3 12h9"],
  phrases: ["M4 5h16v11.5H9L5 20v-3.5H4z", "M7.5 9h9M7.5 12.5h6"],
  history: ["M3.5 12a8.5 8.5 0 1 0 2.8-6.3", "M3 4.5l.3 4.3 4.3-.3", "M12 8v4.3l3.3 2"],
  git: ["M6 7.2v9.6", "M18 9.2c0 5-12 3.5-12 7.6", "M6 2.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z", "M6 16.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z", "M18 4.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z"],
  worktree: ["M3 7V5.5A1.5 1.5 0 0 1 4.5 4h4l2 2h9A1.5 1.5 0 0 1 21 7.5V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z", "M12 10v6M9 13h6"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
} as const;
type IconName = keyof typeof ICONS;

function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// ---- DOM の小道具 ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function $(selector: string): Element | null {
  return document.querySelector(selector);
}

function visible(node: Element | null | undefined): node is Element {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function shown(selector: string): boolean {
  return visible($(selector));
}

function focusedPane() {
  const fid = getFocusedId();
  return fid ? getActiveWs()?.panes.get(fid) : undefined;
}

function snapshot(): Ctx {
  const pane = focusedPane();
  return {
    workspaces: workspaces.length,
    panes: getActiveWs()?.panes.size ?? 0,
    cwd: pane ? (pane.cwd ?? pane.spec.cwd) : undefined,
    phrases: document.querySelectorAll("#quick-phrases-list .quick-phrase-row").length,
    clicked: false,
  };
}

/** 1つの要素を切り抜いて矢印で指す（見えなければ中央のカード） */
function single(selector: string | Element | null, prefer?: PointerSide[]): Task {
  const node = typeof selector === "string" ? $(selector) : selector;
  return visible(node) ? { spot: [node], arrow: node, prefer } : { spot: [], arrow: null };
}

/** 領域を切り抜くだけ（説明ステップ）。arrow を渡せばその要素も指す */
function area(selectors: string[], arrow?: string): Task {
  const spot = selectors.map($).filter(visible);
  const a = arrow ? $(arrow) : null;
  return { spot, arrow: visible(a) ? a : null };
}

/** パスバーのフォルダーブラウザー（新規セッションの場所選びの is-pick は対象外） */
function openBrowser(): Element | null {
  const pop = $(".pathbar-pop:not(.is-pick)");
  return visible(pop) ? pop : null;
}

function moveButton(pop: Element): HTMLButtonElement | null {
  return pop.querySelector<HTMLButtonElement>(".pathbar-actions .is-primary");
}

function activeSessions(): number {
  return workspaces.filter((w) => !w.archived).length;
}

const gitOpen = () => shown("#git-window");
const gitRepo = () => gitOpen() && !$("#git-window")!.classList.contains("is-norepo");
const worktreeReady = () => !($("#worktree-open") as HTMLButtonElement | null)?.disabled;

// ---- 各編の定義 ----

const TOURS: TourDef[] = [
  {
    id: "basics",
    icon: "compass",
    back: true,
    steps: [
      {
        id: "session",
        key: "tutorial.session",
        icon: "session",
        // サイドバーをたたんでいれば、まず開くボタンを指す
        task: () => single(shown("#ws-new") ? "#ws-new" : "#sidebar-reopen"),
        // ＋ でも Cmd/Ctrl+T のフォームでも、セッションが増えたら次へ
        done: (c) => workspaces.length > c.workspaces,
        try: true,
        keys: [["tutorial.session.form", "Mod+T"]],
      },
      {
        id: "folder",
        key: "tutorial.folder",
        icon: "folder",
        // 1. ブラウザーが閉じていればパスバー 2. 現在地のままなら移動先のフォルダー行
        // 3. 別のフォルダーを表示していれば「ここへ移動」
        task: () => {
          const pop = openBrowser();
          if (!pop) {
            const bar = focusedPane()?.el.querySelector(":scope > .pane-pathbar .pane-pathbar-path") ?? null;
            return { ...single(bar), phase: 0 };
          }
          const move = moveButton(pop);
          if (move && !move.disabled) return { spot: [pop], arrow: move, phase: 2 };
          // フォルダーが無い場所では「上の階層へ」を指す。行の下に置くと次の行の名前を
          // 隠すので、左（場所の列の余白）から指す
          const row = pop.querySelector(".pathbar-row.is-dir") ?? pop.querySelector(".pathbar-pop-head button");
          return { spot: [pop], arrow: visible(row) ? row : null, phase: 1, prefer: ["left", "below", "above", "right"] };
        },
        // 「ここへ移動」を押したか、シェルの cd でフォルダーが変わったら次へ
        done: (c) => {
          if (c.clicked) return true;
          const pane = focusedPane();
          const cwd = pane ? (pane.cwd ?? pane.spec.cwd) : undefined;
          return !!c.cwd && !!cwd && cwd !== c.cwd;
        },
        // 「ここへ移動」は押した瞬間にブラウザーが閉じるので、クリック自体を捕まえる
        click: ".pathbar-pop:not(.is-pick) .pathbar-actions .is-primary:not(:disabled)",
        tasks: ["tutorial.folder.task1", "tutorial.folder.task2", "tutorial.folder.task3"],
      },
      {
        id: "split",
        key: "tutorial.split",
        icon: "split",
        task: () => ({ ...area(["#split-right", "#split-down"], "#split-right") }),
        // ボタンでもショートカットでも、表示中セッションのペインが増えたら次へ
        done: (c) => (getActiveWs()?.panes.size ?? 0) > c.panes,
        try: true,
        keys: [
          ["tutorial.split.right", "Mod+Shift+D"],
          ["tutorial.split.down", "Mod+Shift+S"],
        ],
      },
    ],
  },
  {
    id: "view",
    icon: "view",
    back: false,
    steps: [
      {
        id: "prep",
        key: "tutorial.view.prep",
        icon: "session",
        skip: () => activeSessions() >= 2,
        task: () => single(shown("#ws-new") ? "#ws-new" : "#sidebar-reopen"),
        done: () => activeSessions() >= 2,
        try: true,
      },
      {
        id: "open",
        key: "tutorial.view.open",
        icon: "view",
        task: () => single("#session-view-open"),
        done: () => shown("#session-view-panel"),
        try: true,
      },
      {
        id: "pick",
        key: "tutorial.view.pick",
        icon: "view",
        needs: () => shown("#session-view-panel"),
        fallback: "open",
        task: () => {
          const row = $("#session-view-list label.bc-row:not(:has(input:checked))");
          return { spot: [$("#session-view-list")].filter(visible), arrow: visible(row) ? row : null, prefer: ["left", "right", "below", "above"] };
        },
        done: () => !($("#session-view-apply") as HTMLButtonElement | null)?.disabled,
        try: true,
      },
      {
        id: "modes",
        key: "tutorial.view.modes",
        icon: "view",
        needs: () => shown("#session-view-panel"),
        fallback: "open",
        task: () => area(["#session-view-modes"]),
      },
      {
        id: "apply",
        key: "tutorial.view.apply",
        icon: "view",
        needs: () => shown("#session-view-panel") || !!$("#grid.multi-session"),
        fallback: "open",
        task: () => single("#session-view-apply"),
        done: () => !!$("#grid.multi-session") && !shown("#session-view-panel"),
        try: true,
      },
      {
        id: "header",
        key: "tutorial.view.header",
        icon: "view",
        task: () => area([".workspace-view-header"], ".workspace-view-header .workspace-view-solo"),
      },
    ],
  },
  {
    id: "phrases",
    icon: "phrases",
    back: false,
    steps: [
      {
        id: "open",
        key: "tutorial.phrases.open",
        icon: "phrases",
        task: () => single("#quick-phrases-open"),
        done: () => shown("#quick-phrases-panel"),
        try: true,
      },
      {
        id: "add",
        key: "tutorial.phrases.add",
        icon: "phrases",
        needs: () => shown("#quick-phrases-panel"),
        fallback: "open",
        task: () => {
          const input = $("#quick-phrase-input") as HTMLInputElement | null;
          const typed = !!input?.value.trim();
          // 入力欄の下は保存先の選択肢なので、左から指す
          return {
            spot: [$("#quick-phrases-form")].filter(visible),
            arrow: $(typed ? "#quick-phrase-submit" : "#quick-phrase-input"),
            phase: typed ? 1 : 0,
            prefer: ["left", "above", "below", "right"],
          };
        },
        done: (c) => document.querySelectorAll("#quick-phrases-list .quick-phrase-row").length > c.phrases,
        tasks: ["tutorial.phrases.add.task1", "tutorial.phrases.add.task2"],
      },
      {
        id: "scope",
        key: "tutorial.phrases.scope",
        icon: "phrases",
        needs: () => shown("#quick-phrases-panel"),
        fallback: "open",
        task: () => area(["#quick-phrase-scope"]),
      },
      {
        id: "use",
        key: "tutorial.phrases.use",
        icon: "phrases",
        needs: () => shown("#quick-phrases-panel"),
        fallback: "open",
        task: () => {
          const rows = [...document.querySelectorAll("#quick-phrases-list .quick-phrase-use")];
          const last = rows[rows.length - 1] ?? null;
          return { spot: [$("#quick-phrases-list")].filter(visible), arrow: visible(last) ? last : null, prefer: ["left", "below", "above", "right"] };
        },
        // 入力に成功するとダイアログが閉じるので、クリック自体を捕まえる
        click: "#quick-phrases-list .quick-phrase-use",
        done: (c) => c.clicked && !shown("#quick-phrases-panel"),
        try: true,
      },
      {
        id: "bar",
        key: "tutorial.phrases.bar",
        icon: "phrases",
        task: () => area(["#quick-phrase-bar"], "#quick-phrase-bar .quick-phrase-chip"),
      },
    ],
  },
  {
    id: "history",
    icon: "history",
    back: false,
    steps: [
      {
        id: "open",
        key: "tutorial.history.open",
        icon: "history",
        task: () => single("#prompt-history-open"),
        done: () => shown("#prompt-history-panel"),
        try: true,
      },
      {
        id: "sessions",
        key: "tutorial.history.sessions",
        icon: "history",
        needs: () => shown("#prompt-history-panel"),
        fallback: "open",
        task: () => area(["#prompt-history-sessions"]),
      },
      {
        id: "timeline",
        key: "tutorial.history.timeline",
        icon: "history",
        needs: () => shown("#prompt-history-panel"),
        fallback: "open",
        task: () => area(["#prompt-history-timeline"], "#prompt-history-timeline .ph-insert"),
      },
      {
        id: "close",
        key: "tutorial.history.close",
        icon: "history",
        task: () => single("#prompt-history-close"),
        done: () => !shown("#prompt-history-panel"),
        try: true,
      },
      {
        id: "takeover",
        key: "tutorial.history.takeover",
        icon: "history",
        task: () => single("#takeover-open"),
        done: () => shown("#history-panel"),
        try: true,
      },
      {
        id: "conversations",
        key: "tutorial.history.conversations",
        icon: "history",
        needs: () => shown("#history-panel"),
        fallback: "takeover",
        task: () => area(["#takeover-panel"], "#takeover-panel .takeover-open-btn"),
      },
      {
        id: "trashTab",
        key: "tutorial.history.trashTab",
        icon: "history",
        needs: () => shown("#history-panel"),
        fallback: "takeover",
        task: () => single("#history-tab-trash"),
        done: () => shown("#session-trash-panel"),
        try: true,
      },
      {
        id: "trash",
        key: "tutorial.history.trash",
        icon: "history",
        needs: () => shown("#history-panel"),
        fallback: "takeover",
        task: () => area(["#session-trash-panel"], "#session-trash-panel .session-trash-restore"),
      },
    ],
  },
  {
    id: "git",
    icon: "git",
    back: false,
    steps: [
      {
        id: "open",
        key: "tutorial.git.open",
        icon: "git",
        task: () => single("#git-open"),
        done: gitOpen,
        try: true,
        keys: [["tutorial.git.shortcut", "Mod+E"]],
      },
      {
        id: "norepo",
        key: "tutorial.git.norepo",
        icon: "git",
        skip: () => gitRepo(),
        needs: gitOpen,
        fallback: "open",
        task: () => area(["#gw-empty"]),
      },
      { id: "side", key: "tutorial.git.side", icon: "git", skip: () => !gitRepo(), needs: gitOpen, fallback: "open",
        task: () => area(["#gw-side"]) },
      { id: "status", key: "tutorial.git.status", icon: "git", skip: () => !gitRepo(), needs: gitOpen, fallback: "open",
        task: () => ({ ...area(["#gw-view-status"], "#commit-message"), prefer: ["above", "right", "left", "below"] }) },
      { id: "tools", key: "tutorial.git.tools", icon: "git", skip: () => !gitRepo(), needs: gitOpen, fallback: "open",
        task: () => area(["#gw-tools"]) },
      {
        id: "historyNav",
        key: "tutorial.git.historyNav",
        icon: "git",
        skip: () => !gitRepo(),
        needs: gitOpen,
        fallback: "open",
        task: () => single("#gw-nav-history", ["right", "below", "above", "left"]),
        done: () => shown("#gw-view-history"),
        try: true,
      },
      { id: "graph", key: "tutorial.git.graph", icon: "git", skip: () => !gitRepo(), needs: gitOpen, fallback: "open",
        task: () => area(["#gw-view-history"]) },
      { id: "issues", key: "tutorial.git.issues", icon: "git", skip: () => !gitRepo(), needs: gitOpen, fallback: "open",
        task: () => area(["#gw-nav-issues", "#gw-nav-prs"], "#gw-nav-issues") },
      {
        id: "close",
        key: "tutorial.git.close",
        icon: "git",
        task: () => single("#gw-close"),
        done: () => !gitOpen(),
        try: true,
      },
      {
        id: "wtInfo",
        key: "tutorial.git.wtInfo",
        icon: "worktree",
        skip: worktreeReady,
        task: () => single("#worktree-open"),
      },
      {
        id: "wtOpen",
        key: "tutorial.git.wtOpen",
        icon: "worktree",
        skip: () => !worktreeReady(),
        task: () => single("#worktree-open"),
        done: () => shown("#worktree-panel"),
        try: true,
      },
      {
        id: "wtForm",
        key: "tutorial.git.wtForm",
        icon: "worktree",
        skip: () => !worktreeReady(),
        needs: () => shown("#worktree-panel"),
        fallback: "wtOpen",
        task: () => area(["#worktree-panel"], "#worktree-submit"),
      },
    ],
  },
];

const tourById = (id: TourId) => TOURS.find((tour) => tour.id === id)!;

/** 各編が開くダイアログの閉じるボタン。別の編を始める前に閉じ、対象が隠れないようにする */
const DIALOG_CLOSERS = [
  "#session-view-close",
  "#quick-phrases-close",
  "#prompt-history-close",
  "#history-close",
  "#worktree-close",
  "#gw-close",
];

function closeTourDialogs(): void {
  for (const sel of DIALOG_CLOSERS) {
    const b = $(sel) as HTMLButtonElement | null;
    if (visible(b)) b.click();
  }
}
/** ロック中は機能自体が開けない編（分割表示と基本はロック対象外） */
const LOCKABLE = new Set<TourId>(["phrases", "history", "git"]);

// ---- 配置 ----

function unionRect(nodes: Element[]): DOMRect | null {
  if (!nodes.length) return null;
  let l = Infinity, top = Infinity, r = -Infinity, b = -Infinity;
  for (const n of nodes) {
    const rect = n.getBoundingClientRect();
    l = Math.min(l, rect.left);
    top = Math.min(top, rect.top);
    r = Math.max(r, rect.right);
    b = Math.max(b, rect.bottom);
  }
  return new DOMRect(l - PAD, top - PAD, r - l + PAD * 2, b - top + PAD * 2);
}

const POINTER_W = 36;
const POINTER_H = 50;

type PointerSide = "below" | "above" | "left" | "right";

/** 矢印を対象のどちら側に置くか。画面内に収まり、カードと重ならない最初の候補 */
function pointerPlacement(
  target: DOMRect,
  card: DOMRect,
  vw: number,
  vh: number,
  prefer: PointerSide[] = ["below", "above", "left", "right"],
) {
  // 横長の対象（フォルダー行）は名前のある先頭寄りを指す
  const ax = target.left + Math.min(target.width / 2, 56);
  const ay = target.top + target.height / 2;
  const candidates: { side: PointerSide; cx: number; cy: number; w: number; h: number }[] = [
    { side: "below", cx: ax, cy: target.bottom + 6 + POINTER_H / 2, w: POINTER_W, h: POINTER_H },
    { side: "above", cx: ax, cy: target.top - 6 - POINTER_H / 2, w: POINTER_W, h: POINTER_H },
    { side: "left", cx: target.left - 6 - POINTER_H / 2, cy: ay, w: POINTER_H, h: POINTER_W },
    { side: "right", cx: target.right + 6 + POINTER_H / 2, cy: ay, w: POINTER_H, h: POINTER_W },
  ];
  return prefer.map((side) => candidates.find((c) => c.side === side)!).find((c) => {
    const l = c.cx - c.w / 2, r = c.cx + c.w / 2, t = c.cy - c.h / 2, b = c.cy + c.h / 2;
    const inView = l >= 4 && t >= 4 && r <= vw - 4 && b <= vh - 4;
    const hitsCard = l < card.right && r > card.left && t < card.bottom && b > card.top;
    return inView && !hitsCard;
  });
}

const POINTER_ROTATE: Record<PointerSide, number> = { below: 0, above: 180, left: 90, right: -90 };

function pointerEl(): HTMLElement {
  const wrap = el("div", "tut-pointer");
  const inner = el("div", "tut-pointer-inner");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${POINTER_W} ${POINTER_H}`);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  // 上向きの太い矢印（回転で4方向に使う）
  path.setAttribute("d", "M18 2 L34 21 H24.5 V47 H11.5 V21 H2 Z");
  svg.append(path);
  inner.append(svg);
  wrap.append(inner);
  return wrap;
}

function shortcut(keys: string): string {
  const mac = getHostOs() === "macos";
  return keys
    .split("+")
    .map((k) => (k === "Mod" ? (mac ? "⌘" : "Ctrl") : k === "Shift" ? (mac ? "⇧" : "Shift") : k))
    .join(mac ? "" : "+");
}

function kbdRow(label: string, keys: string): HTMLElement {
  const row = el("div", "tut-key");
  row.append(el("span", "tut-key-label", label), el("kbd", "", shortcut(keys)));
  return row;
}

const msg = (key: string) => t(key as MsgKey);

// ---- 起動 ----

/** 開発ビルド専用: 保存状態に関係なくツアーを出す（完了・スキップしても保存しない）。
    `VITE_TUTORIAL=welcome|update npm run tauri dev`、ブラウザなら `?tutorial=welcome|update` */
function devForcedIntro(): "welcome" | "update" | null {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get("tutorial") ?? import.meta.env.VITE_TUTORIAL;
  return v === "welcome" || v === "update" ? v : null;
}

/** 初回ならツアーを開き、終わったら（初回でなければ即）解決する */
export function runTutorialIfPending(d: TutorialDeps): Promise<void> {
  deps = d;
  document.querySelector<HTMLButtonElement>("#tutorial-open")!.onclick = () => void openTutorial({ screen: "picker" });
  const forced = devForcedIntro();
  if (forced) return openTutorial({ screen: "welcome", intro: forced, persist: false });
  const w = window as unknown as Record<string, unknown>;
  if (w.__devMock && w.__mockTutorial !== true) mode = null;
  return mode ? openTutorial({ screen: "welcome", intro: mode }) : Promise.resolve();
}

type Screen = "welcome" | "picker" | "step" | "done" | "hint";

function openTutorial(opts: { screen: Screen; intro?: "welcome" | "update"; persist?: boolean }): Promise<void> {
  // 別のツアーに置き換えるときは、前のカードをフェードさせずにすぐ消す（2枚重ねない）
  running?.finish(true);
  const intro = opts.intro ?? "welcome";
  const persist = opts.persist ?? true;
  return new Promise((resolve) => {
    const root = el("div", "tut");
    root.id = "tutorial";
    const scrim = el("div", "tut-scrim");
    const spot = el("div", "tut-spot");
    const card = el("div", "tut-card");
    const pointer = pointerEl();
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-live", "polite");
    card.tabIndex = -1;
    root.append(scrim, spot, pointer, card);
    document.body.append(root);

    let screen: Screen = opts.screen;
    let tour: TourDef = TOURS[0];
    let index = 0;
    let ctx = snapshot();
    let placed = "";
    let finished = false;
    // 初回の流れ（導入カードから始めた）だけ、閉じる前に「ツアー」ボタンの紹介を一度はさむ
    let hintPending = opts.screen === "welcome";

    const finish = (immediate = false) => {
      if (finished) return;
      if (hintPending && !immediate) {
        hintPending = false;
        saveFirstRunDone();
        show("hint");
        return;
      }
      finished = true;
      window.clearInterval(timer);
      window.removeEventListener("resize", place);
      document.removeEventListener("click", onDocClick, true);
      if (immediate) root.remove();
      else {
        root.classList.add("is-leaving");
        window.setTimeout(() => root.remove(), 180);
      }
      if (running?.finish === finish) running = undefined;
      saveFirstRunDone();
      resolve();
    };

    /** 初回のツアーは見終えた扱いにする（紹介の画面で終了しても次回は出さない） */
    function saveFirstRunDone() {
      if (persist && mode) {
        mode = null;
        deps?.onChange();
      }
    }
    running = { finish };

    const show = (next: Screen) => {
      // 一覧を開いた時点で「ツアー」の場所は伝わっている
      if (next === "picker") hintPending = false;
      screen = next;
      placed = "";
      render();
      place();
    };

    const startTour = (id: TourId) => {
      closeTourDialogs();
      tour = tourById(id);
      goStep(0);
    };

    /** index へ進む（skip の当てはまるステップは飛ばし、末尾なら完了画面） */
    const goStep = (to: number) => {
      let i = Math.max(0, to);
      while (i < tour.steps.length && tour.steps[i].skip?.()) i++;
      if (i >= tour.steps.length) {
        if (persist && !toursDone.has(tour.id)) {
          toursDone.add(tour.id);
          deps?.onChange();
        }
        show("done");
        return;
      }
      index = i;
      ctx = snapshot();
      show("step");
    };

    const goId = (id: string) => goStep(tour.steps.findIndex((s) => s.id === id));

    function button(parent: HTMLElement, key: MsgKey, cls: string, onClick: () => void) {
      const b = el("button", cls, t(key));
      b.type = "button";
      b.onclick = onClick;
      parent.append(b);
      return b;
    }

    function renderWelcome() {
      if (intro === "update") {
        // 既存ユーザー向け: 「アップデートされました」のバッジと現在のバージョン
        const badge = el("div", "tut-update-badge");
        const ver = el("span", "tut-update-ver");
        badge.append(icon("done"), el("span", "", t("tutorial.update.badge")), ver);
        card.append(badge);
        void invoke<string>("app_version").then(
          (v) => { if (v) ver.textContent = `v${v.replace(/^v/, "")}`; },
          () => {},
        );
      }
      const art = el("div", "tut-art");
      for (const [i, step] of tourById("basics").steps.entries()) {
        const tile = el("div", "tut-tile");
        tile.style.setProperty("--i", String(i));
        tile.append(el("span", "tut-tile-num", String(i + 1)), icon(step.icon), el("span", "tut-tile-label", msg(`${step.key}.short`)));
        art.append(tile);
      }
      card.append(art);
      const copy = intro === "update" ? "tutorial.update" : "tutorial.welcome";
      card.append(el("h2", "tut-title", msg(`${copy}.title`)), el("p", "tut-body", msg(`${copy}.body`)));
      const actions = el("div", "tut-actions");
      button(actions, "tutorial.later", "tut-btn is-ghost", () => finish());
      return button(actions, "tutorial.start", "tut-btn is-primary", () => startTour("basics")).parentElement!;
    }

    function renderPicker() {
      card.append(el("h2", "tut-title", t("tutorial.picker.title")), el("p", "tut-body", t("tutorial.picker.body")));
      const list = el("div", "tut-tours");
      for (const [i, def] of TOURS.entries()) {
        const item = el("button", "tut-tour");
        item.type = "button";
        item.dataset.tour = def.id;
        item.style.setProperty("--i", String(i));
        const locked = LOCKABLE.has(def.id) && isLocked();
        const text = el("span", "tut-tour-text");
        text.append(el("span", "tut-tour-name", msg(`tutorial.tour.${def.id}.name`)), el("span", "tut-tour-desc", msg(`tutorial.tour.${def.id}.desc`)));
        const meta = el("span", "tut-tour-meta");
        if (locked) {
          meta.append(icon("lock"), el("span", "", t("tutorial.picker.locked")));
          item.disabled = true;
        } else if (toursDone.has(def.id)) {
          meta.classList.add("is-done");
          meta.append(icon("done"), el("span", "", t("tutorial.picker.done")));
        }
        const badge = el("span", "tut-tour-icon");
        badge.append(icon(def.icon));
        item.append(badge, text, meta);
        item.onclick = () => startTour(def.id);
        list.append(item);
      }
      card.append(list);
      const actions = el("div", "tut-actions");
      button(actions, "tutorial.close", "tut-btn is-primary", () => finish());
      return actions;
    }

    /** いまの環境で通るステップだけを数える（リポジトリ外の Git 編など） */
    const liveSteps = () => tour.steps.filter((s, i) => i === index || !s.skip?.());

    function renderStep() {
      const step = tour.steps[index];
      const live = liveSteps();
      const kicker = el("div", "tut-kicker");
      kicker.append(
        icon(step.icon),
        el("span", "", `${msg(`tutorial.tour.${tour.id}.name`)} · ${t("tutorial.stepOf", { n: String(live.indexOf(step) + 1), total: String(live.length) })}`),
      );
      card.append(kicker, el("h2", "tut-title", msg(`${step.key}.title`)), el("p", "tut-body", msg(`${step.key}.body`)));
      if (step.keys) {
        const keys = el("div", "tut-keys");
        for (const [label, combo] of step.keys) keys.append(kbdRow(t(label), combo));
        card.append(keys);
      }
      if (step.tasks) {
        // 段階ごとのチェックリスト（いまの段階は place() で反映する）
        const list = el("ol", "tut-tasks");
        for (const key of step.tasks) {
          const item = el("li", "tut-task");
          item.append(el("span", "tut-task-mark"), el("span", "tut-task-label", t(key)));
          list.append(item);
        }
        card.append(list);
      }
      if (step.try) card.append(el("p", "tut-try", msg(`${step.key}.try`)));

      const actions = el("div", "tut-actions");
      // 操作のステップは実際に押して進む。「次へ」は説明のステップだけ
      button(actions, "tutorial.skip", "tut-btn is-ghost tut-skip", () => finish());
      if (tour.back && index > 0) button(actions, "tutorial.back", "tut-btn", () => goStep(index - 1));
      if (!step.done) {
        const last = tour.steps.slice(index + 1).every((s) => s.skip?.());
        button(actions, last ? "tutorial.finishTour" : "tutorial.next", "tut-btn is-primary", () => goStep(index + 1));
      }
      return actions;
    }

    function renderDone() {
      const art = el("div", "tut-art");
      const badge = el("div", "tut-done-badge");
      badge.append(icon("done"));
      art.append(badge);
      card.append(art);
      if (tour.id === "basics") {
        card.append(el("h2", "tut-title", t("tutorial.done.title")), el("p", "tut-body", t("tutorial.done.body")));
      } else {
        const name = msg(`tutorial.tour.${tour.id}.name`);
        card.append(el("h2", "tut-title", t("tutorial.doneTour.title", { tour: name })), el("p", "tut-body", t("tutorial.doneTour.body")));
      }
      const actions = el("div", "tut-actions");
      button(actions, "tutorial.more", "tut-btn", () => show("picker"));
      button(actions, tour.id === "basics" ? "tutorial.finish" : "tutorial.close", "tut-btn is-primary", () => finish());
      return actions;
    }

    function renderHint() {
      const kicker = el("div", "tut-kicker");
      kicker.append(icon("compass"), el("span", "", t("toolbar.tour")));
      card.append(kicker, el("h2", "tut-title", t("tutorial.hint.title")), el("p", "tut-body", t("tutorial.hint.body")));
      card.append(el("p", "tut-try", t("tutorial.hint.try")));
      const actions = el("div", "tut-actions");
      button(actions, "tutorial.gotIt", "tut-btn is-primary", () => finish());
      return actions;
    }

    function render() {
      root.dataset.step = screen === "step" ? `${tour.id}:${tour.steps[index].id}` : screen;
      root.dataset.screen = screen;
      root.dataset.tour = tour.id;
      card.replaceChildren();
      const actions =
        screen === "welcome" ? renderWelcome()
        : screen === "picker" ? renderPicker()
        : screen === "done" ? renderDone()
        : screen === "hint" ? renderHint()
        : renderStep();

      const foot = el("div", "tut-foot");
      const dots = el("div", "tut-dots");
      if (screen === "step") {
        const live = liveSteps();
        const at = live.indexOf(tour.steps[index]);
        for (const [i] of live.entries()) {
          const dot = el("span", "tut-dot");
          if (i === at) dot.classList.add("is-current");
          else if (i < at) dot.classList.add("is-done");
          dots.append(dot);
        }
      } else {
        dots.hidden = true;
      }
      foot.append(dots, actions);
      card.append(foot);
      // 中央のカードのときだけフォーカスを移す（ステップ中はターミナル入力を妨げない）
      if (screen !== "step" && screen !== "hint") {
        requestAnimationFrame(() =>
          card.querySelector<HTMLElement>(".tut-btn.is-primary:not(:disabled), .tut-tour:not(:disabled)")?.focus(),
        );
      }
    }

    function place() {
      if (finished) return;
      const step = screen === "step" ? tour.steps[index] : undefined;
      const task = screen === "hint" ? single("#tutorial-open") : step?.task();
      const rect = task ? unionRect(task.spot) : null;
      card.querySelectorAll(".tut-task").forEach((item, i) => {
        item.classList.toggle("is-done", i < (task?.phase ?? 0));
        item.classList.toggle("is-current", i === (task?.phase ?? 0));
      });
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      root.classList.toggle("is-centered", !rect);
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      let x: number, y: number, side = "center";
      if (!rect) {
        x = (vw - cw) / 2;
        y = (vh - ch) / 2;
      } else {
        const room = {
          right: vw - rect.right - GAP,
          left: rect.left - GAP,
          bottom: vh - rect.bottom - GAP,
          top: rect.top - GAP,
        };
        const fits = (["right", "bottom", "left", "top"] as const).find((s) =>
          s === "right" || s === "left" ? room[s] >= cw + 8 : room[s] >= ch + 8,
        );
        // 周りに収まらない大きな対象（ブラウザー・ダイアログ）は広い側の端に寄せて一部だけ重ねる
        side = fits ?? (room.left > room.right ? "over-left" : "over-right");
        const midY = rect.top + rect.height / 2 - ch / 2;
        const midX = rect.left + rect.width / 2 - cw / 2;
        if (side === "right") [x, y] = [rect.right + GAP, midY];
        else if (side === "left") [x, y] = [rect.left - GAP - cw, midY];
        else if (side === "bottom") [x, y] = [midX, rect.bottom + GAP];
        else if (side === "top") [x, y] = [midX, rect.top - GAP - ch];
        else if (side === "over-left") [x, y] = [rect.left - GAP - cw, midY];
        else [x, y] = [rect.right + GAP, midY];
      }
      x = Math.max(12, Math.min(vw - cw - 12, x));
      y = Math.max(12, Math.min(vh - ch - 12, y));
      const arrowRect = task?.arrow?.getBoundingClientRect();
      const key = [rect?.x, rect?.y, rect?.width, rect?.height, x, y, cw, ch,
        arrowRect?.x, arrowRect?.y, arrowRect?.width, arrowRect?.height].join("|");
      if (key === placed) return;
      placed = key;
      card.dataset.side = side;
      card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (rect) {
        spot.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
        spot.style.width = `${rect.width}px`;
        spot.style.height = `${rect.height}px`;
        // 吹き出しの矢印は対象の中心を指す（カードの辺に沿ってずらす）
        const arrow =
          side === "right" || side === "left"
            ? rect.top + rect.height / 2 - y
            : rect.left + rect.width / 2 - x;
        const span = side === "right" || side === "left" ? ch : cw;
        card.style.setProperty("--arrow", `${Math.max(18, Math.min(span - 18, arrow))}px`);
      }
      // 次に押す場所を指す矢印
      const at = arrowRect && pointerPlacement(arrowRect, new DOMRect(x, y, cw, ch), vw, vh, task?.prefer);
      pointer.classList.toggle("is-shown", !!at);
      if (at) {
        pointer.style.transform =
          `translate(${Math.round(at.cx - POINTER_W / 2)}px, ${Math.round(at.cy - POINTER_H / 2)}px) rotate(${POINTER_ROTATE[at.side]}deg)`;
      }
    }

    function tick() {
      if (screen === "step") {
        const step = tour.steps[index];
        if (step.done?.(ctx)) {
          goStep(index + 1);
          return;
        }
        if (step.needs && !step.needs() && step.fallback) {
          goId(step.fallback);
          return;
        }
      }
      place();
    }

    /** 押すと消えるボタン（ここへ移動・定型文）はクリック自体を捕まえる */
    function onDocClick(e: MouseEvent) {
      const sel = screen === "step" ? tour.steps[index].click : undefined;
      if (sel && e.target instanceof Element && e.target.closest(sel)) ctx.clicked = true;
    }

    card.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    });
    document.addEventListener("click", onDocClick, true);
    const timer = window.setInterval(tick, TICK_MS);
    window.addEventListener("resize", place);
    show(screen);
  });
}
