/// <reference types="vite/client" />
// ============================================================
// 初回チュートリアル（スポットライト型のツアー）
//
// 初回起動（session.json が無い）と、v1.0.0 より前から使っていた人の最初の起動
// （保存データに tutorial が無い）で一度だけ、基本の3操作を順に案内する。
// 後者は導入カードを「アップデートされました」の案内にする。
//   1. サイドバーの ＋ で新しいセッションを作る
//   2. ペイン下部のパスバー / フォルダーブラウザーで作業フォルダーを選ぶ
//   3. ツールバーの分割ボタンでペインを分割する
// - 導入と完了だけは画面全体を覆うカード。各ステップは対象を切り抜き、次に押す場所を
//   動く矢印で指す。クリックは塞がず、実際に操作したときだけ次へ進む（「次へ」は置かない）。
//   フォルダーのステップは「パスバー → 移動先のフォルダー → ここへ移動」を1つずつ指す
// - 対象の矩形は開いている間だけ短い間隔で測り直す（ブラウザーの開閉・サイドバーの
//   たたみ・ウィンドウのリサイズに追従）。ツアー外では何も動かさない
// - ターミナルのフォーカスやキー入力は奪わない。Esc はカード内だけで受ける
// - 完了・スキップで "done" を保存し、以後は設定 → ヘルプからだけ再表示できる
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t, type MsgKey } from "../../i18n";
import { getActiveWs, getFocusedId, getHostOs, workspaces } from "../../workspace/state";

type TutorialDeps = {
  /** 完了状態の保存（scheduleSave） */
  onChange: () => void;
  /** 設定から再表示するときに設定パネルを閉じる */
  closeSettings: () => void;
};

type StepId = "welcome" | "session" | "folder" | "split" | "done";

/** いま操作してほしい場所。spot を切り抜き、arrow を矢印で指す。phase は段階つきの
    ステップ（フォルダー）の何段目か */
type Task = { spot: Element[]; arrow: Element | null; phase: number; prefer?: PointerSide[] };

type Step = {
  id: StepId;
  /** 対象を解決する。未定義なら画面中央のカード */
  task?: () => Task;
  /** 対象の操作を検知して自動で次へ進む条件（tick ごとに評価） */
  advanced?: (start: Snapshot) => boolean;
};

type Snapshot = { workspaces: number; panes: number; cwd: string | undefined; moved: boolean };

const ORDER: StepId[] = ["welcome", "session", "folder", "split", "done"];
const TOUR: StepId[] = ["session", "folder", "split"];
const FOLDER_TASKS = ["tutorial.folder.task1", "tutorial.folder.task2", "tutorial.folder.task3"] as const;
const TICK_MS = 120;
const GAP = 14;
const PAD = 6;

/** welcome = 初回インストール、update = v1.0.0 より前からの更新。null は表示済み */
export type TutorialMode = "welcome" | "update" | null;

let mode: TutorialMode = null;
let deps: TutorialDeps | undefined;
let running: { finish: () => void } | undefined;

/** 保存値の読み込み（session.ts の boot） */
export function setTutorialMode(m: TutorialMode): void {
  mode = m;
}

export function getTutorialMode(): TutorialMode {
  return mode;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  session: ["M4 5.5h16v13H4z", "M12 9v6M9 12h6"],
  folder: ["M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2h8.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z", "M8 13h8M13 10l3 3-3 3"],
  split: ["M3.5 4.5h17v15h-17z", "M12 4.5v15", "M12 12h8.5"],
  done: ["M5 12.5l4.5 4.5L19 7.5"],
} as const;

function icon(name: keyof typeof ICONS): SVGSVGElement {
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function visible(node: Element | null | undefined): node is Element {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function focusedPane() {
  const fid = getFocusedId();
  return fid ? getActiveWs()?.panes.get(fid) : undefined;
}

function snapshot(): Snapshot {
  const pane = focusedPane();
  return {
    workspaces: workspaces.length,
    panes: getActiveWs()?.panes.size ?? 0,
    cwd: pane ? (pane.cwd ?? pane.spec.cwd) : undefined,
    moved: false,
  };
}

function single(node: Element | null): Task {
  return visible(node) ? { spot: [node], arrow: node, phase: 0 } : { spot: [], arrow: null, phase: 0 };
}

/** パスバーのフォルダーブラウザー（新規セッションの場所選びの is-pick は対象外） */
function openBrowser(): Element | null {
  const pop = document.querySelector(".pathbar-pop:not(.is-pick)");
  return visible(pop) ? pop : null;
}

function moveButton(pop: Element): HTMLButtonElement | null {
  return pop.querySelector<HTMLButtonElement>(".pathbar-actions .is-primary");
}

const STEPS: Record<StepId, Step> = {
  welcome: { id: "welcome" },
  session: {
    id: "session",
    // サイドバーをたたんでいれば、まず開くボタンを指す
    task: () => single(
      visible(document.querySelector("#ws-new"))
        ? document.querySelector("#ws-new")
        : document.querySelector("#sidebar-reopen"),
    ),
    // ＋ でも Cmd/Ctrl+T のフォームでも、セッションが増えたら次へ
    advanced: (start) => workspaces.length > start.workspaces,
  },
  folder: {
    id: "folder",
    // 1. ブラウザーが閉じていればパスバー 2. 現在地のままなら移動先のフォルダー行
    // 3. 別のフォルダーを表示していれば「ここへ移動」
    task: () => {
      const pop = openBrowser();
      if (!pop) {
        const bar = focusedPane()?.el.querySelector(":scope > .pane-pathbar .pane-pathbar-path") ?? null;
        return single(bar);
      }
      const move = moveButton(pop);
      if (move && !move.disabled) return { spot: [pop], arrow: move, phase: 2 };
      // フォルダーが無い場所では「上の階層へ」を指す
      const row = pop.querySelector(".pathbar-row.is-dir") ?? pop.querySelector(".pathbar-pop-head button");
      // 行の下に置くと次の行の名前を隠すので、左（場所の列の余白）から指す
      return { spot: [pop], arrow: visible(row) ? row : null, phase: 1, prefer: ["left", "below", "above", "right"] };
    },
    // 「ここへ移動」を押したか、シェルの cd でフォルダーが変わったら次へ
    advanced: (start) => {
      if (start.moved) return true;
      const pane = focusedPane();
      const cwd = pane ? (pane.cwd ?? pane.spec.cwd) : undefined;
      return !!start.cwd && !!cwd && cwd !== start.cwd;
    },
  },
  split: {
    id: "split",
    task: () => {
      const right = document.querySelector("#split-right");
      const down = document.querySelector("#split-down");
      return { spot: [right, down].filter(visible), arrow: visible(right) ? right : null, phase: 0 };
    },
    // ボタンでもショートカットでも、表示中セッションのペインが増えたら次へ
    advanced: (start) => (getActiveWs()?.panes.size ?? 0) > start.panes,
  },
  done: { id: "done" },
};

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
  document.querySelector<HTMLButtonElement>("#settings-tutorial-replay")!.onclick = () => {
    d.closeSettings();
    void startTutorial("welcome");
  };
  const forced = devForcedIntro();
  if (forced) return startTutorial(forced, false);
  const w = window as unknown as Record<string, unknown>;
  if (w.__devMock && w.__mockTutorial !== true) mode = null;
  return mode ? startTutorial(mode) : Promise.resolve();
}

function startTutorial(intro: "welcome" | "update", persist = true): Promise<void> {
  running?.finish();
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

    let index = 0;
    let start = snapshot();
    let placed = "";
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearInterval(timer);
      window.removeEventListener("resize", place);
      document.removeEventListener("click", onDocClick, true);
      root.classList.add("is-leaving");
      window.setTimeout(() => root.remove(), 180);
      if (running?.finish === finish) running = undefined;
      if (persist && mode) {
        mode = null;
        deps?.onChange();
      }
      resolve();
    };
    running = { finish };

    const go = (to: number) => {
      index = Math.max(0, Math.min(ORDER.length - 1, to));
      start = snapshot();
      placed = "";
      render();
      place();
    };

    function render() {
      const step = STEPS[ORDER[index]];
      root.dataset.step = step.id;
      card.replaceChildren();
      const tourAt = TOUR.indexOf(step.id);

      if (step.id === "welcome" && intro === "update") {
        // 既存ユーザー向け: 「アップデートされました」のバッジと現在のバージョン
        const badge = el("div", "tut-update-badge");
        const label = el("span", "", t("tutorial.update.badge"));
        const ver = el("span", "tut-update-ver");
        badge.append(icon("done"), label, ver);
        card.append(badge);
        void invoke<string>("app_version").then(
          (v) => { if (v) ver.textContent = `v${v.replace(/^v/, "")}`; },
          () => {},
        );
      }
      if (step.id === "welcome" || step.id === "done") {
        const art = el("div", "tut-art");
        if (step.id === "welcome") {
          for (const [i, id] of TOUR.entries()) {
            const tile = el("div", "tut-tile");
            tile.style.setProperty("--i", String(i));
            tile.append(
              el("span", "tut-tile-num", String(i + 1)),
              icon(id as keyof typeof ICONS),
              el("span", "tut-tile-label", t(`tutorial.${id}.short` as MsgKey)),
            );
            art.append(tile);
          }
        } else {
          const badge = el("div", "tut-done-badge");
          badge.append(icon("done"));
          art.append(badge);
        }
        card.append(art);
      } else {
        const kicker = el("div", "tut-kicker");
        kicker.append(icon(step.id as keyof typeof ICONS), el("span", "", t("tutorial.stepOf", { n: String(tourAt + 1), total: String(TOUR.length) })));
        card.append(kicker);
      }

      const copy = step.id === "welcome" && intro === "update" ? "update" : step.id;
      const title = el("h2", "tut-title", t(`tutorial.${copy}.title` as MsgKey));
      title.id = "tut-title";
      card.setAttribute("aria-labelledby", title.id);
      card.append(title, el("p", "tut-body", t(`tutorial.${copy}.body` as MsgKey)));

      if (step.id === "session") {
        const keys = el("div", "tut-keys");
        keys.append(kbdRow(t("tutorial.session.form"), "Mod+T"));
        card.append(keys, el("p", "tut-try", t("tutorial.session.try")));
      } else if (step.id === "folder") {
        // 段階ごとのチェックリスト（いまの段階は place() で反映する）
        const list = el("ol", "tut-tasks");
        for (const key of FOLDER_TASKS) {
          const item = el("li", "tut-task");
          item.append(el("span", "tut-task-mark"), el("span", "tut-task-label", t(key)));
          list.append(item);
        }
        card.append(list);
      } else if (step.id === "split") {
        const keys = el("div", "tut-keys");
        keys.append(
          kbdRow(t("tutorial.split.right"), "Mod+Shift+D"),
          kbdRow(t("tutorial.split.down"), "Mod+Shift+S"),
        );
        card.append(keys, el("p", "tut-try", t("tutorial.split.try")));
      }

      const foot = el("div", "tut-foot");
      const dots = el("div", "tut-dots");
      for (const [i] of TOUR.entries()) {
        const dot = el("span", "tut-dot");
        if (i === tourAt) dot.classList.add("is-current");
        else if (i < tourAt || step.id === "done") dot.classList.add("is-done");
        dots.append(dot);
      }
      if (step.id === "welcome") dots.hidden = true;
      const actions = el("div", "tut-actions");
      const button = (key: MsgKey, cls: string, onClick: () => void) => {
        const b = el("button", cls, t(key));
        b.type = "button";
        b.onclick = onClick;
        actions.append(b);
        return b;
      };
      let primary: HTMLButtonElement;
      if (step.id === "welcome") {
        button("tutorial.later", "tut-btn is-ghost", finish);
        primary = button("tutorial.start", "tut-btn is-primary", () => go(index + 1));
      } else if (step.id === "done") {
        primary = button("tutorial.finish", "tut-btn is-primary", finish);
      } else {
        // 操作のステップは実際に押して進む。「次へ」は置かず、抜け道はスキップだけ
        primary = button("tutorial.skip", "tut-btn is-ghost tut-skip", finish);
        if (tourAt > 0) button("tutorial.back", "tut-btn", () => go(index - 1));
      }
      foot.append(dots, actions);
      card.append(foot);
      // 全画面カードのときだけフォーカスを移す（ステップ中はターミナル入力を妨げない）
      if (!step.task) requestAnimationFrame(() => primary.focus());
    }

    function place() {
      if (finished) return;
      const step = STEPS[ORDER[index]];
      const task = step.task?.();
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
        // 周りに収まらない大きな対象（フォルダーブラウザー）は広い側の端に寄せて一部だけ重ねる。
        // ブラウザー右下の操作ボタンは隠さない
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
      const step = STEPS[ORDER[index]];
      if (step.advanced?.(start)) {
        go(index + 1);
        return;
      }
      place();
    }

    card.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    });
    // 「ここへ移動」は押した瞬間にブラウザーが閉じるので、クリック自体を捕まえる
    function onDocClick(e: MouseEvent) {
      if (ORDER[index] !== "folder" || !(e.target instanceof Element)) return;
      const pop = openBrowser();
      const move = pop && moveButton(pop);
      if (move && !move.disabled && move.contains(e.target)) start.moved = true;
    }
    document.addEventListener("click", onDocClick, true);
    const timer = window.setInterval(tick, TICK_MS);
    window.addEventListener("resize", place);
    go(0);
  });
}
