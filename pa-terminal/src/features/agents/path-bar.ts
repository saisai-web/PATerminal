// ============================================================
// ペイン下部のパスバー + アプリ内フォルダーブラウザー
//
// すべてのペインの最下部（claude / codex なら入力欄のすぐ下）に現在のフォルダを出す。
// クリックすると OS の Finder / エクスプローラーではなく、アプリ内のポップオーバーで
// フォルダを辿れる。辿った先はパスのコピー・お気に入り・ターミナルの移動（シェルは cd、エージェントは会話を引き継ぐ既存の切り替えダイアログ）に使える。
//
// - cwd が分かった時点でバーを出す（Pane の生成時と OSC 7 の cd で syncPathBar）。
//   エージェント種別のラベルは検知スイープ（watch.ts の apply）が更新する。
// - 「ルート」は一覧の表示先を既定のルート（新規ターミナルの起動場所 = ホーム）へ切り替える。
//   バーの出現で .pane-body の高さが変わり、ペインの ResizeObserver が refit する
//   （CLAUDE.md: refit → resize の順序はそのまま。ここから pty_resize は呼ばない）
// - fs_list は開いているフォルダ1つ分だけ、操作時に直列で呼ぶ（定期実行しない）
// - 他機能の操作は main.ts から callback で受け取り、import の循環を作らない
// - ブラウザーは既定 760×640 で開き、端のハンドルで大きさを変えられる（localStorage に残す）。
//   広い間は左に「場所」列（ターミナルのフォルダー・ホーム・お気に入り・最近使った場所）を出す。
//   作成・移動は表示中のフォルダーに対して右下のボタンからだけ行う（行ごとの操作は置かない）
// - サイドバーの新規セッション入口（場所フライアウト）も openFolderPicker で同じブラウザーを
//   開き、選んだフォルダーにセッションを作る
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { t } from "../../i18n";
import { copyText } from "../../shared/clipboard";
import type { Pane } from "../../terminal/pane";
import { getHostOs, panes } from "../../workspace/state";
import { getRecentDirs } from "../sidebar/recent-dirs";
import type { FsEntry, FsListing } from "../../workspace/types";
import { joinPath, normPath, parentPath, pathBasename } from "../explorer/paths";

type PathBarDeps = {
  /** アプリ内ビューアーでファイルを開く */
  openFile: (path: string) => void;
  /** ターミナルをフォルダへ移動する（シェルは cd、エージェントは切り替えダイアログ） */
  moveTo: (pane: Pane, path: string) => void;
  /** お気に入りフォルダ（新規セッションの場所と共有。保存は features/explorer） */
  favorites: () => string[];
  toggleFavorite: (path: string) => void;
  /** ペインをフォーカスする（setFocused） */
  focusPane: (pane: Pane) => void;
  /** フォルダーで新しいセッションを作る（サイドバーのクイック作成と同じ配置） */
  newSession: (path: string) => void;
  /** OS のフォルダ選択（Finder / エクスプローラー）。キャンセルは null */
  pickFolderFromOs: () => Promise<string | null>;
};

let deps: PathBarDeps | undefined;
let home: string | undefined;
let closeBrowser: (() => void) | undefined;

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  folder: "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  file: "M4.5 2.5h4.5l3 3v8h-7.5zM9 2.5v3h3",
  up: "M8 12.5v-9M4.5 7 8 3.5 11.5 7",
  chevron: "M6 4l4 4-4 4",
  caret: "M4.5 10 8 6.5l3.5 3.5",
  target: "M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  star: "M8 2.4l1.7 3.5 3.8.55-2.75 2.7.65 3.8L8 11.15l-3.4 1.8.65-3.8-2.75-2.7 3.8-.55z",
  close: "M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5",
  home: "M2.5 7.5 8 3l5.5 4.5M4 6.5v6.5h3v-3.5h2V13h3V6.5",
  move: "M2.5 8h9M8.5 4.5 12 8l-3.5 3.5",
  plus: "M8 3.5v9M3.5 8h9",
} as const;

function icon(name: keyof typeof ICONS, className = "pathbar-icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(className);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

export function initPathBar(d: PathBarDeps): void {
  deps = d;
  void homeDir().then(
    (h) => {
      home = normPath(h);
      // 取得前に出したバーの ~ 表記を反映し直す
      for (const pane of panes.values()) syncPathBar(pane);
    },
    () => {},
  );
}

/** ホーム配下は ~ で短く見せる（表示専用。操作は常に絶対パスで行う） */
export function displayPath(path: string): string {
  if (home && home !== "/" && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function paneCwd(pane: Pane): string | undefined {
  const p = pane.cwd ?? pane.spec.cwd;
  return p ? normPath(p) : undefined;
}

/** ターミナルの既定のルート = 新しいターミナルが最初に開く場所（cwd 指定なしの
    pty_spawn はホームで起動する）。ホーム未取得の間は undefined */
function defaultRoot(): string | undefined {
  return home;
}

function live(pane: Pane): boolean {
  return pane.alive && panes.get(pane.id) === pane;
}

/** cwd が分かっているペインにバーを出し、cwd やエージェント種別が変わったときだけ
    DOM を書き換える。agent を省略すると直近の検知結果のまま（OSC 7 の cd から呼ぶ） */
export function syncPathBar(pane: Pane, agent?: string | null): void {
  const cwd = paneCwd(pane);
  let bar = pane.el.querySelector<HTMLDivElement>(":scope > .pane-pathbar");
  if (!cwd) return;
  if (!bar) {
    bar = createBar(pane);
    pane.el.append(bar);
  }
  if (agent !== undefined && (bar.dataset.agent ?? null) !== agent) {
    if (agent) bar.dataset.agent = agent;
    else delete bar.dataset.agent;
    const label = bar.querySelector<HTMLSpanElement>(".pane-pathbar-agent")!;
    label.textContent = agent ?? "";
    label.hidden = !agent;
  }
  const shown = displayPath(cwd);
  if (bar.dataset.cwd !== cwd || bar.dataset.shown !== shown) {
    bar.dataset.cwd = cwd;
    bar.dataset.shown = shown;
    const leaf = pathBasename(shown);
    const parent = shown.slice(0, shown.length - leaf.length);
    // 長い親パスは先頭側を省略し、末尾のフォルダ名は常に見せる
    bar.querySelector(".pane-pathbar-parent")!.textContent = parent ? `‎${parent}‎` : "";
    bar.querySelector(".pane-pathbar-leaf")!.textContent = leaf;
    bar.querySelector<HTMLButtonElement>(".pane-pathbar-path")!.title = `${cwd}\n${t("pathbar.browse")}`;
  }
}

/** そのペインのフォルダーブラウザーを開く（バーのクリックから）。
    ブラウザーはペイン下部のバーに付いて開く */
function openPathBrowser(pane: Pane): void {
  syncPathBar(pane);
  const bar = pane.el.querySelector<HTMLDivElement>(":scope > .pane-pathbar");
  const button = bar?.querySelector<HTMLButtonElement>(".pane-pathbar-path");
  const cwd = bar?.dataset.cwd;
  if (!bar || !button || !cwd || bar.dataset.open === "true") return;
  deps?.focusPane(pane);
  openBrowser(pane, bar, button, cwd);
}

/** 作成直後のペインでフォルダーブラウザーを開く（ルートに作ったセッションを作業フォルダーへ
    移すため）。表示・layout が済んでからバーの位置に合わせて開く */
export function openPathBrowserAfterCreate(pane: Pane): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (live(pane) && !pane.ws.layer.hidden) openPathBrowser(pane);
  }));
}

function createBar(pane: Pane): HTMLDivElement {
  const bar = document.createElement("div");
  bar.className = "pane-pathbar";
  const agentEl = document.createElement("span");
  agentEl.className = "pane-pathbar-agent";
  agentEl.hidden = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pane-pathbar-path";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  const parent = document.createElement("span");
  parent.className = "pane-pathbar-parent";
  const leaf = document.createElement("span");
  leaf.className = "pane-pathbar-leaf";
  button.append(icon("folder"), parent, leaf, icon("caret", "pathbar-caret"));
  button.onclick = (e) => {
    e.stopPropagation();
    if (bar.dataset.open === "true") closeBrowser?.();
    else openPathBrowser(pane);
  };
  bar.append(agentEl, button);
  return bar;
}

type Row = { entry: FsEntry; path: string };

type BrowserOpts = {
  /** 最初に表示するフォルダー。「現在地へ戻る」の戻り先も兼ねる */
  start: string;
  /** ポップオーバーの位置の基準にする要素 */
  anchor: HTMLElement;
  /** パスバーから: ペインの操作（ここへ移動・新規セッション）を出す */
  pane?: { pane: Pane; bar: HTMLDivElement };
  /** 新規セッションの場所選び: 主ボタンで表示中フォルダーを onPick に渡す */
  pick?: { label: string; onPick: (path: string) => void };
};

/** 「Finderから選択」の文言（ユーザーの呼び名に合わせて Finder / エクスプローラー） */
function osPickLabel(): string {
  if (getHostOs() === "macos") return t("pathbar.osPickMac");
  if (getHostOs() === "windows") return t("pathbar.osPickWin");
  return t("pathbar.osPickOther");
}

// ---- 大きさ: 既定はパスバー初版（380×400）の約2倍。四隅の1つ + 2辺のハンドルで変えられ、
//      変えた大きさは閲覧者ごとの利便として localStorage に残す（無くても既定で開く）
const SIZE_KEY = "pa.folderBrowserSize";
const DEFAULT_SIZE = { w: 760, h: 640 };
const MIN_W = 420;
const MIN_H = 260;
/** これ以上の幅では左に「場所」列（ホーム・お気に入り・最近使った場所）を出す */
const SIDE_MIN_W = 600;

function loadSize(): { w: number; h: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    if (v && Number.isFinite(v.w) && Number.isFinite(v.h)) return { w: v.w, h: v.h };
  } catch {
    /* 既定の大きさで開く */
  }
  return { ...DEFAULT_SIZE };
}

function saveSize(size: { w: number; h: number } | null) {
  try {
    if (size) localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    else localStorage.removeItem(SIZE_KEY);
  } catch {
    /* 保存できなくても今回の表示には影響しない */
  }
}

function openBrowser(pane: Pane, bar: HTMLDivElement, anchor: HTMLButtonElement, start: string) {
  closeBrowser?.();
  if (!deps || !live(pane)) return;
  bar.dataset.open = "true";
  anchor.setAttribute("aria-expanded", "true");
  openFolderBrowser({ start, anchor, pane: { pane, bar } }, (refocus) => {
    delete bar.dataset.open;
    anchor.setAttribute("aria-expanded", "false");
    if (refocus && live(pane)) deps?.focusPane(pane);
  });
}

/** 新規セッションの場所をアプリ内のフォルダーブラウザーで選ぶ（サイドバーの作成入口から）。
    主ボタンで表示中のフォルダーを onPick に渡して閉じる */
export function openFolderPicker(
  anchor: HTMLElement,
  start: string,
  label: string,
  onPick: (path: string) => void,
): void {
  openFolderBrowser({ start: normPath(start), anchor, pick: { label, onPick } }, () => {});
}

function openFolderBrowser(opts: BrowserOpts, onClosed: (refocus: boolean) => void) {
  closeBrowser?.();
  if (!deps) return;
  const d = deps;
  const target = opts.pane;
  const pane = target?.pane;
  const anchorRect = opts.anchor.getBoundingClientRect();
  // パスバーからはバーの上へ（下端固定）、サイドバーの入口からはボタンの下へ（上端固定）
  const above = !!target;
  const origin = opts.start;
  let current = opts.start;
  let listing: FsListing | null = null;
  let error: string | null = null;
  let loading = false;
  let token = 0;
  let rows: Row[] = [];
  let selected = 0;
  let closed = false;
  let size = loadSize();
  /** OS のフォルダ選択を開いている間は、ウィンドウの blur で閉じない */
  let osDialog = false;

  const pop = document.createElement("div");
  pop.className = "pathbar-pop";
  pop.classList.toggle("is-above", above);
  pop.classList.toggle("is-pick", !!opts.pick);
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", opts.pick ? opts.pick.label : t("pathbar.browse"));

  // ---- 見出し: 上へ / パンくず / 現在地へ戻る
  const head = document.createElement("div");
  head.className = "pathbar-pop-head";
  const upBtn = iconButton("up", t("pathbar.up"), () => {
    const p = parentPath(current);
    if (p) navigate(p);
  });
  const crumbs = document.createElement("div");
  crumbs.className = "pathbar-crumbs";
  const currentBtn = iconButton("target", t("pathbar.current"), () => navigate(origin));
  head.append(upBtn, crumbs, currentBtn);

  // ---- 左列: 場所（ターミナルのフォルダー・ホーム）/ お気に入り / 最近使った場所
  const side = document.createElement("div");
  side.className = "pathbar-side";

  // ---- 絞り込み
  const filterWrap = document.createElement("div");
  filterWrap.className = "pathbar-filter";
  const filter = document.createElement("input");
  filter.type = "text";
  filter.placeholder = t("pathbar.filter");
  filter.spellcheck = false;
  filter.autocomplete = "off";
  filter.setAttribute("aria-controls", "pathbar-list");
  filterWrap.append(filter);

  // ---- 一覧
  const list = document.createElement("div");
  list.className = "pathbar-list";
  list.id = "pathbar-list";
  list.setAttribute("role", "listbox");

  const main = document.createElement("div");
  main.className = "pathbar-main";
  main.append(filterWrap, list);
  const body = document.createElement("div");
  body.className = "pathbar-body";
  body.append(side, main);

  // ---- 操作（表示中のフォルダに対して）
  const actions = document.createElement("div");
  actions.className = "pathbar-actions";
  // 一覧の表示先を既定のルート（新規ターミナルの起動場所 = ホーム）へ切り替えるだけ。
  // ターミナル自体の移動は「ここへ移動」に一本化する
  const rootBtn = actionButton("home", t("pathbar.root"), () => {
    const root = defaultRoot();
    if (root) void navigate(root);
  });
  const copyBtn = actionButton("copy", t("pathbar.copy"), () => {
    void copyText(current).then(() => {
      if (closed) return;
      copyBtn.classList.add("is-done");
      copyBtn.querySelector("span")!.textContent = t("pathbar.copied");
      window.setTimeout(() => {
        copyBtn.classList.remove("is-done");
        copyBtn.querySelector("span")!.textContent = t("pathbar.copy");
      }, 1200);
    });
  });
  // お気に入り: ボタンの上に小さなメニューを開き、表示中フォルダの追加/解除と
  // 登録済みフォルダへのジャンプ（一覧の表示先を切り替えるだけ）を行う
  const favBtn = actionButton("star", t("pathbar.favorites"), () => {
    if (favMenu) closeFavMenu();
    else renderFavMenu();
  });
  favBtn.classList.add("pathbar-fav-btn");
  favBtn.setAttribute("aria-haspopup", "menu");
  favBtn.setAttribute("aria-expanded", "false");
  let favMenu: HTMLDivElement | null = null;
  actions.append(rootBtn, copyBtn, favBtn);

  // Finder / エクスプローラーで選んだフォルダーへ一覧の表示先を移す（作成・移動は各主ボタン）
  const osBtn = actionButton("folder", osPickLabel(), () => {
    osDialog = true;
    void d.pickFolderFromOs().then(
      (path) => {
        osDialog = false;
        if (closed) return;
        if (path) void navigate(path);
        filter.focus();
      },
      () => {
        osDialog = false;
      },
    );
  });
  osBtn.classList.add("pathbar-os-pick");
  actions.append(osBtn);

  // パスバーからは「新規セッション」+「ここへ移動」、場所選びでは入口ごとの主ボタン1つ
  const newSessionBtn = target
    ? actionButton("plus", t("pathbar.newSession"), () => startSession(current))
    : null;
  if (newSessionBtn) {
    newSessionBtn.classList.add("pathbar-new-session");
    newSessionBtn.title = t("pathbar.newSessionTitle");
    actions.append(newSessionBtn);
  }
  const primaryBtn = actionButton(
    "move",
    opts.pick ? opts.pick.label : t("pathbar.move"),
    () => runPrimary(current),
  );
  primaryBtn.classList.add("is-primary");
  actions.append(primaryBtn);

  // ---- 大きさ変更ハンドル（アンカーの反対側の辺と右辺、その角）
  const grips = (["y", "x", "xy"] as const).map((axis) => {
    const g = document.createElement("div");
    g.className = `pathbar-grip is-${axis}`;
    g.title = t("pathbar.resize");
    g.setAttribute("aria-hidden", "true");
    g.addEventListener("pointerdown", (e) => startResize(e, axis));
    g.addEventListener("dblclick", () => {
      saveSize(null);
      size = { ...DEFAULT_SIZE };
      position();
    });
    return g;
  });

  pop.append(head, body, actions, ...grips);
  document.body.append(pop);

  function iconButton(name: keyof typeof ICONS, label: string, onClick: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pathbar-icon-btn";
    b.title = label;
    b.setAttribute("aria-label", label);
    b.append(icon(name));
    b.onclick = onClick;
    return b;
  }

  function actionButton(name: keyof typeof ICONS, label: string, onClick: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pathbar-action";
    const text = document.createElement("span");
    text.textContent = label;
    b.append(icon(name), text);
    b.onclick = onClick;
    return b;
  }

  /** 主ボタン: パスバーからはターミナルの移動、場所選びでは入口へ渡す */
  function runPrimary(path: string) {
    if (opts.pick) {
      const onPick = opts.pick.onPick;
      close(false);
      onPick(path);
      return;
    }
    if (!pane || path === origin) return;
    close();
    if (live(pane)) d.moveTo(pane, path);
  }

  /** 新規セッションはそちらがフォーカスを持つので、ペインへは戻さない */
  function startSession(path: string) {
    close(false);
    d.newSession(path);
  }

  function updateFavBtn() {
    favBtn.classList.toggle("is-on", d.favorites().includes(current));
  }

  function closeFavMenu() {
    favMenu?.remove();
    favMenu = null;
    favBtn.setAttribute("aria-expanded", "false");
  }

  function toggleFavorite(path: string) {
    d.toggleFavorite(path);
    updateFavBtn();
    renderSide();
  }

  function renderFavMenu() {
    favMenu?.remove();
    const menu = document.createElement("div");
    menu.className = "pathbar-favs";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t("pathbar.favorites"));
    const list = d.favorites();
    const isFav = list.includes(current);

    // 表示中フォルダの追加 / 解除
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pathbar-fav-toggle";
    toggle.classList.toggle("is-on", isFav);
    toggle.setAttribute("role", "menuitem");
    const toggleText = document.createElement("span");
    toggleText.className = "pathbar-fav-toggle-text";
    toggleText.textContent = isFav ? t("pathbar.favRemove") : t("pathbar.favAdd");
    const here = document.createElement("span");
    here.className = "pathbar-fav-here";
    here.textContent = pathBasename(displayPath(current));
    toggle.append(icon("star"), toggleText, here);
    toggle.onclick = () => {
      toggleFavorite(current);
      renderFavMenu();
      // 作り直しでフォーカスが body へ落ちると Esc がポップオーバーに届かない
      favMenu?.querySelector<HTMLButtonElement>(".pathbar-fav-toggle")?.focus();
    };
    menu.append(toggle);

    if (list.length === 0) {
      menu.append(message(t("pathbar.favEmpty"), "is-muted"));
    } else {
      const rowsEl = document.createElement("div");
      rowsEl.className = "pathbar-fav-list";
      for (const path of list) {
        const row = document.createElement("div");
        row.className = "pathbar-fav-row";
        row.setAttribute("role", "menuitem");
        row.tabIndex = 0;
        row.title = path;
        row.classList.toggle("is-current", path === current);
        const name = document.createElement("span");
        name.className = "pathbar-fav-name";
        name.textContent = pathBasename(displayPath(path));
        const parent = parentPath(path);
        const context = document.createElement("span");
        context.className = "pathbar-fav-context";
        // rtl で先頭側を省略しても / や ~ が入れ替わらないよう LRM で囲む
        context.textContent = parent ? `‎${displayPath(parent)}‎` : "";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "pathbar-fav-remove";
        remove.title = t("pathbar.favDelete");
        remove.setAttribute("aria-label", t("pathbar.favDelete"));
        remove.append(icon("close"));
        remove.onclick = (e) => {
          e.stopPropagation();
          toggleFavorite(path);
          renderFavMenu();
          favMenu?.querySelector<HTMLButtonElement>(".pathbar-fav-toggle")?.focus();
        };
        const jump = () => {
          closeFavMenu();
          void navigate(path);
          filter.focus();
        };
        row.onclick = jump;
        row.onkeydown = (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          jump();
        };
        row.append(icon("folder"), name, context, remove);
        rowsEl.append(row);
      }
      menu.append(rowsEl);
    }
    const left = Math.min(favBtn.offsetLeft, pop.clientWidth - 280 - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.bottom = `${actions.offsetHeight + 6}px`;
    pop.append(menu);
    favMenu = menu;
    favBtn.setAttribute("aria-expanded", "true");
  }

  /** 左列の1行。クリックは一覧の表示先を切り替えるだけ（ターミナルは動かさない） */
  function sideItem(label: string, path: string, iconName: keyof typeof ICONS, onRemove?: () => void) {
    const item = document.createElement("div");
    item.className = "pathbar-side-item";
    item.classList.toggle("is-current", path === current);
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    item.title = path;
    const name = document.createElement("span");
    name.className = "pathbar-side-name";
    name.textContent = label;
    item.append(icon(iconName), name);
    item.onclick = () => {
      void navigate(path);
      filter.focus();
    };
    item.onkeydown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      item.click();
    };
    if (onRemove) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pathbar-side-remove";
      remove.title = t("pathbar.favDelete");
      remove.setAttribute("aria-label", t("pathbar.favDelete"));
      remove.append(icon("close"));
      remove.onclick = (e) => {
        e.stopPropagation();
        onRemove();
      };
      item.append(remove);
    }
    return item;
  }

  function sideSection(label: string, items: HTMLElement[]) {
    if (!items.length) return;
    const h = document.createElement("div");
    h.className = "pathbar-side-head";
    h.textContent = label;
    side.append(h, ...items);
  }

  function renderSide() {
    side.textContent = "";
    const places: HTMLElement[] = [];
    places.push(sideItem(
      pane ? t("pathbar.terminalDir") : pathBasename(displayPath(origin)),
      origin,
      "target",
    ));
    const root = defaultRoot();
    if (root) places.push(sideItem(t("loc.home"), root, "home"));
    sideSection(t("pathbar.places"), places);
    const favs = d.favorites();
    sideSection(t("pathbar.favorites"), favs.map((p) =>
      sideItem(pathBasename(displayPath(p)), p, "star", () => toggleFavorite(p))));
    sideSection(t("loc.recent"), getRecentDirs()
      .filter((p) => p !== origin && !favs.includes(p))
      .map((p) => sideItem(pathBasename(displayPath(p)), p, "folder")));
  }

  function position() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxW = Math.max(240, vw - 16);
    const w = Math.min(Math.max(size.w, MIN_W), maxW);
    const left = Math.max(8, Math.min(anchorRect.left, vw - w - 8));
    pop.style.width = `${w}px`;
    pop.style.left = `${left}px`;
    // 高さは固定し、フォルダを移るたびに上端が跳ねないようにする
    if (above) {
      const maxH = Math.max(200, anchorRect.top - 12);
      pop.style.height = `${Math.min(Math.max(size.h, MIN_H), maxH)}px`;
      pop.style.bottom = `${vh - anchorRect.top + 6}px`;
      pop.style.top = "";
    } else {
      const h = Math.min(Math.max(size.h, MIN_H), vh - 16);
      const top = Math.max(8, Math.min(anchorRect.bottom + 4, vh - h - 8));
      pop.style.height = `${h}px`;
      pop.style.top = `${top}px`;
      pop.style.bottom = "";
    }
    pop.classList.toggle("has-side", w >= SIDE_MIN_W);
  }

  function startResize(down: PointerEvent, axis: "x" | "y" | "xy") {
    down.preventDefault();
    const grip = down.currentTarget as HTMLElement;
    try {
      grip.setPointerCapture(down.pointerId);
    } catch {
      /* キャプチャ不可でも move は届く範囲で動く */
    }
    // 開くアニメーションの scale を含まない実寸で測る
    const startW = pop.offsetWidth;
    const startH = pop.offsetHeight;
    pop.classList.add("is-resizing");
    closeFavMenu();
    const move = (e: PointerEvent) => {
      const dx = e.clientX - down.clientX;
      const dy = e.clientY - down.clientY;
      size = {
        w: axis === "y" ? startW : startW + dx,
        // 下端固定（パスバーの上）は上へ引くと伸び、上端固定は下へ引くと伸びる
        h: axis === "x" ? startH : above ? startH - dy : startH + dy,
      };
      position();
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      pop.classList.remove("is-resizing");
      // 画面に収めた後の実寸を残す
      size = { w: pop.offsetWidth, h: pop.offsetHeight };
      saveSize(size);
      filter.focus();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  function renderCrumbs() {
    crumbs.textContent = "";
    const shown = displayPath(current);
    const tilde = shown !== current;
    const parts: Array<{ label: string; target: string }> = [];
    const drive = current.match(/^([A-Za-z]:\/)(.*)$/);
    let root = drive ? drive[1] : "/";
    let rest = drive ? drive[2] : current.slice(1);
    if (tilde && home) {
      root = home;
      rest = current.slice(home.length + 1);
      parts.push({ label: "~", target: home });
    } else {
      parts.push({ label: root, target: root });
    }
    let target = root;
    for (const seg of rest.split("/").filter(Boolean)) {
      target = joinPath(target, seg);
      parts.push({ label: seg, target });
    }
    parts.forEach((part, i) => {
      if (i > 0) {
        const sep = icon("chevron", "pathbar-crumb-sep");
        crumbs.append(sep);
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pathbar-crumb";
      b.textContent = part.label;
      b.title = part.target;
      if (i === parts.length - 1) b.setAttribute("aria-current", "location");
      b.onclick = () => navigate(part.target);
      crumbs.append(b);
    });
    requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    upBtn.disabled = parentPath(current) === null;
    currentBtn.disabled = current === origin;
    updateFavBtn();
    const rootPath = defaultRoot();
    rootBtn.disabled = !rootPath || current === rootPath;
    rootBtn.title = rootPath ?? "";
    if (opts.pick) {
      primaryBtn.title = current;
    } else {
      primaryBtn.disabled = current === origin;
      primaryBtn.title = current === origin ? t("pathbar.here") : current;
    }
    renderSide();
  }

  function computeRows() {
    const q = filter.value.trim().toLowerCase();
    const entries = (listing?.entries ?? []).filter((e) => {
      // ドットファイルは「.」から絞り込んだときだけ出す
      if (e.name.startsWith(".") && !q.startsWith(".")) return false;
      return !q || e.name.toLowerCase().includes(q);
    });
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    rows = entries.map((entry) => ({ entry, path: joinPath(current, entry.name) }));
    selected = Math.min(selected, Math.max(0, rows.length - 1));
  }

  function renderList() {
    list.textContent = "";
    if (loading && !listing) {
      list.append(message(t("pathbar.loading"), "is-muted"));
      return;
    }
    if (error) {
      list.append(message(t("exp.readError", { error }), "is-error"));
      return;
    }
    if (rows.length === 0) {
      list.append(message(filter.value ? t("exp.noMatch") : t("pathbar.empty"), "is-muted"));
      return;
    }
    rows.forEach((row, i) => {
      const item = document.createElement("div");
      item.className = "pathbar-row";
      item.id = `pathbar-row-${i}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === selected));
      item.classList.toggle("is-dir", row.entry.isDir);
      item.title = row.path;
      const name = document.createElement("span");
      name.className = "pathbar-row-name";
      name.textContent = row.entry.name;
      item.append(icon(row.entry.isDir ? "folder" : "file"), name);
      if (row.entry.isDir) item.append(icon("chevron", "pathbar-row-chevron"));
      item.onmousemove = () => {
        if (selected === i) return;
        selected = i;
        updateSelection(false);
      };
      item.onclick = () => activate(row);
      list.append(item);
    });
    if (listing?.truncated) list.append(message(t("exp.truncated"), "is-muted"));
    updateSelection(true);
  }

  function message(text: string, cls: string) {
    const el = document.createElement("div");
    el.className = `pathbar-msg ${cls}`;
    el.textContent = text;
    return el;
  }

  function updateSelection(scroll: boolean) {
    list.querySelectorAll<HTMLElement>(".pathbar-row").forEach((el, i) => {
      el.setAttribute("aria-selected", String(i === selected));
      if (i === selected && scroll) el.scrollIntoView({ block: "nearest" });
    });
    if (rows.length) filter.setAttribute("aria-activedescendant", `pathbar-row-${selected}`);
    else filter.removeAttribute("aria-activedescendant");
  }

  function activate(row: Row) {
    if (row.entry.isDir) navigate(row.path);
    else {
      // ビューアーがフォーカスを持つので、ペインへは戻さない
      close(false);
      d.openFile(row.path);
    }
  }

  async function navigate(path: string) {
    const target = normPath(path);
    const my = ++token;
    closeFavMenu();
    current = target;
    filter.value = "";
    selected = 0;
    loading = true;
    error = null;
    listing = null;
    renderCrumbs();
    // 速い応答ではローディング表示を出さない（ちらつき防止）
    const spinner = window.setTimeout(() => { if (my === token && loading) renderList(); }, 120);
    try {
      const result = await invoke<FsListing>("fs_list", { path: target });
      if (my !== token || closed) return;
      listing = result;
    } catch (e) {
      if (my !== token || closed) return;
      error = String(e);
    } finally {
      window.clearTimeout(spinner);
    }
    loading = false;
    computeRows();
    renderList();
  }

  /** refocus: Esc や操作の完了ではペインへ戻す。外側クリック等ではクリック先に任せる */
  function close(refocus = true) {
    if (closed) return;
    closed = true;
    token++;
    pop.remove();
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("resize", dismissQuietly);
    window.removeEventListener("blur", onWindowBlur);
    if (closeBrowser === dismissQuietly) closeBrowser = undefined;
    onClosed(refocus);
  }
  function dismissQuietly() {
    close(false);
  }
  function onWindowBlur() {
    if (!osDialog) close(false);
  }
  closeBrowser = dismissQuietly;

  function onOutside(e: MouseEvent) {
    if (e.target instanceof Node && (pop.contains(e.target) || opts.anchor.contains(e.target))) return;
    close(false);
  }
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("resize", dismissQuietly);
  window.addEventListener("blur", onWindowBlur);

  pop.addEventListener("mousedown", (e) => {
    if (!favMenu || !(e.target instanceof Node)) return;
    if (favMenu.contains(e.target) || favBtn.contains(e.target)) return;
    closeFavMenu();
  });
  filter.oninput = () => {
    selected = 0;
    computeRows();
    renderList();
  };
  pop.addEventListener("keydown", (e) => {
    // グローバルショートカットやターミナルへキーを流さない
    e.stopPropagation();
    const inFilter = e.target === filter;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (favMenu) {
          closeFavMenu();
          favBtn.focus();
        } else close();
        return;
      case "ArrowDown":
      case "ArrowUp":
        if (!rows.length || favMenu?.contains(e.target as Node)) return;
        e.preventDefault();
        selected = (selected + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        updateSelection(true);
        return;
      case "Enter":
        if (!inFilter) return;
        // Cmd/Ctrl+Enter は表示中のフォルダーで主ボタン（移動 / 場所の決定）
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (!primaryBtn.disabled) runPrimary(current);
          return;
        }
        if (!rows[selected]) return;
        e.preventDefault();
        activate(rows[selected]);
        return;
      case "ArrowRight":
        if (!inFilter || filter.selectionStart !== filter.value.length) return;
        if (rows[selected]?.entry.isDir) {
          e.preventDefault();
          void navigate(rows[selected].path);
        }
        return;
      case "ArrowLeft":
      case "Backspace":
        if (!inFilter || filter.value) return;
        e.preventDefault();
        {
          const p = parentPath(current);
          if (p) void navigate(p);
        }
        return;
    }
  });

  position();
  renderCrumbs();
  void navigate(opts.start);
  filter.focus();
}
