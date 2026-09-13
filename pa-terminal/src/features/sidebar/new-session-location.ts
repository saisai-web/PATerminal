// ============================================================
// 新規セッションの場所フライアウト（ホーム / フォルダ選択 / お気に入り / 最近使った場所）
// 作成ボタン・メニュー項目のホバーまたはクリックで出るフライアウトから、
// 作成先ディレクトリだけを選べるようにする（Issue #192）。
//
// - 対象: サイドバー左上の +・詳細フォームの場所欄・各メニューの「セッションを作成」
//   （グループ見出し / Whole 枠の + と右クリック、サイドバー余白の右クリック）
// - 選んだ場所は各入口の既存の配置規則（グループ・挿入位置）のまま cwd だけ差し替える
// - フォルダ選択は履歴引き継ぎの「参照…」と同じ plugin-dialog の OS ダイアログ
// - 「Finderから開く…」はフライアウトの行だけでなく、検索欄横 / グループ見出し / Whole の
//   専用ボタンと各メニューの直接項目からも同じダイアログを開く（pickFolderFromOs）
// ============================================================

import { homeDir } from "@tauri-apps/api/path";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import { getHostOs } from "../../workspace/state";
import { getExplorerFavorites } from "../explorer/explorer";
import { explorerParentContext, normPath, pathBasename } from "../explorer/paths";
import { getRecentDirs } from "./recent-dirs";

export type LocationPick = (cwd: string) => void;

type FlyoutOpts = {
  /** ctx-menu の項目に付ける場合 true: ▸ 印を足し、メニュー要素の内側（右横）に出す */
  submenu?: boolean;
  /** クリックでも開閉する（クリックに既存動作が無いボタン用。フォームの場所欄など） */
  openOnClick?: boolean;
  /** false の場合はホバーで開かず、クリックで開いたまま外側クリックまで維持する */
  openOnHover?: boolean;
  /** 場所一覧の先頭に「表示中ペインと同じ場所」を追加したい入口の既定動作 */
  defaultAction?: () => void;
};

// 同時に開くフライアウトは常に1つ。ホバーの出入りで開閉するため
// open / close ともに短い猶予タイマーを挟む（隙間の横断で閉じない・通過しただけで開かない）
const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 300;

let flyoutEl: HTMLDivElement | null = null;
let flyoutAnchor: HTMLElement | null = null;
let openTimer = 0;
let closeTimer = 0;

export function closeLocationFlyout() {
  window.clearTimeout(openTimer);
  window.clearTimeout(closeTimer);
  flyoutEl?.remove();
  flyoutEl = null;
  flyoutAnchor = null;
}

function cancelClose() {
  window.clearTimeout(closeTimer);
}

function scheduleClose() {
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(closeLocationFlyout, CLOSE_DELAY_MS);
}

/** OS のフォルダ選択ダイアログの文言（ユーザーの呼び名に合わせて Finder / エクスプローラー） */
export function osFolderPickLabel(): string {
  if (getHostOs() === "macos") return t("loc.browseMac");
  if (getHostOs() === "windows") return t("loc.browseWin");
  return t("loc.browseOther");
}

/** 「Finderから開く」ボタンのアイコン（開いたフォルダ。既存のアーカイブボタンと同じ線画スタイル） */
export const FOLDER_OPEN_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';

/** OS のフォルダ選択ダイアログを開き、選んだフォルダを正規化して返す（キャンセルは null）。
    ダイアログ表示でウィンドウが blur してメニューやフライアウトが閉じても、
    Promise はそのまま解決するので呼び出し側の作成処理は続行できる */
export function pickFolderFromOs(): Promise<string | null> {
  return openFolderDialog({ directory: true }).then((picked) =>
    typeof picked === "string" && picked ? normPath(picked) : null,
  );
}

function buildRow(name: string, fullPath: string | null, onSelect: () => void): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "loc-row";
  row.setAttribute("role", "menuitem");
  const nameEl = document.createElement("span");
  nameEl.className = "loc-name";
  nameEl.textContent = name;
  row.append(nameEl);
  if (fullPath) {
    const ctx = explorerParentContext(fullPath);
    const pathEl = document.createElement("span");
    pathEl.className = "loc-path";
    pathEl.textContent = ctx.text;
    row.title = fullPath;
    row.append(pathEl);
  }
  row.onclick = (e) => {
    e.stopPropagation();
    onSelect();
  };
  return row;
}

function buildSectionHead(label: string): HTMLDivElement {
  const head = document.createElement("div");
  head.className = "loc-head";
  head.textContent = label;
  return head;
}

function buildFlyout(onPick: LocationPick, opts: FlyoutOpts): HTMLDivElement {
  const el = document.createElement("div");
  el.id = "loc-flyout";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", t("loc.pickTitle"));
  const pick = (path: string) => {
    closeLocationFlyout();
    onPick(normPath(path));
  };

  if (opts.defaultAction) {
    el.append(
      buildRow(t("form.locationDefault"), null, () => {
        closeLocationFlyout();
        opts.defaultAction?.();
      }),
    );
  }
  el.append(
    buildRow(t("loc.home"), null, () => {
      void homeDir().then(
        (home) => pick(home),
        (e) => console.error("homeDir failed:", e),
      );
    }),
    buildRow(osFolderPickLabel(), null, () => {
      void pickFolderFromOs().then((picked) => {
        if (picked) pick(picked);
      });
    }),
  );

  const favorites = getExplorerFavorites();
  if (favorites.length) {
    el.append(buildSectionHead(t("loc.favorites")));
    for (const p of favorites) el.append(buildRow(pathBasename(p), p, () => pick(p)));
  }

  const recents = getRecentDirs();
  if (recents.length) {
    el.append(buildSectionHead(t("loc.recent")));
    for (const p of recents) el.append(buildRow(pathBasename(p), p, () => pick(p)));
  }
  return el;
}

function openFlyout(anchor: HTMLElement, onPick: LocationPick, opts: FlyoutOpts) {
  if (flyoutEl && flyoutAnchor === anchor) return; // 同じアンカーで開いていれば何もしない
  closeLocationFlyout();
  const el = buildFlyout(onPick, opts);
  if (opts.openOnHover !== false) {
    el.addEventListener("mouseenter", cancelClose);
    el.addEventListener("mouseleave", scheduleClose);
  }

  if (opts.submenu && anchor.parentElement) {
    // ctx-menu のサブメニュー: メニュー要素の内側に置けば、メニュー側の
    // 「外側クリックで閉じる」判定（menu.contains）にそのまま乗る
    const menu = anchor.parentElement;
    el.style.position = "absolute";
    menu.append(el);
    const menuRect = menu.getBoundingClientRect();
    // メニューが画面下端近くでも、フライアウト自体は画面内に収める
    const desiredTop = menuRect.top + anchor.offsetTop - 8;
    const clampedTop = Math.max(8, Math.min(desiredTop, window.innerHeight - el.offsetHeight - 8));
    el.style.top = `${clampedTop - menuRect.top}px`;
    // 右に収まらなければ左側へ出す
    if (menuRect.right + el.offsetWidth + 8 <= window.innerWidth) {
      el.style.left = `${menu.clientWidth - 2}px`;
    } else {
      el.style.left = `${-el.offsetWidth + 2}px`;
    }
  } else {
    el.style.position = "fixed";
    document.body.append(el);
    const rect = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8))}px`;
    // 基本はアンカーの下。下端で収まらないときは上へ出す（クランプで重ねると
    // アンカー自体が押せなくなる。エクスプローラー右下の「新規セッション」が該当）
    const below = rect.bottom + 2;
    const top =
      below + el.offsetHeight + 8 <= window.innerHeight
        ? below
        : Math.max(8, rect.top - el.offsetHeight - 2);
    el.style.top = `${top}px`;
  }
  flyoutEl = el;
  flyoutAnchor = anchor;
}

/** 作成ボタン / メニュー項目へ場所フライアウトを付ける。
    既定はホバーで表示し、オプションによりクリック表示へ切り替えられる。 */
export function attachLocationFlyout(
  anchor: HTMLElement,
  onPick: LocationPick,
  opts: FlyoutOpts = {},
) {
  if (opts.submenu) {
    // メニュー項目にはサブメニューがあることを ▸ で示す
    anchor.classList.add("ctx-has-sub");
    const arrow = document.createElement("span");
    arrow.className = "ctx-sub-arrow";
    arrow.textContent = "▸";
    arrow.setAttribute("aria-hidden", "true");
    anchor.append(arrow);
    anchor.setAttribute("aria-haspopup", "menu");
  }
  if (opts.openOnHover !== false) {
    anchor.addEventListener("mouseenter", () => {
      window.clearTimeout(openTimer);
      cancelClose();
      openTimer = window.setTimeout(() => openFlyout(anchor, onPick, opts), OPEN_DELAY_MS);
    });
    anchor.addEventListener("mouseleave", () => {
      window.clearTimeout(openTimer);
      scheduleClose();
    });
  }
  if (opts.openOnClick) {
    anchor.addEventListener("click", (e) => {
      e.stopPropagation();
      if (flyoutEl && flyoutAnchor === anchor) closeLocationFlyout();
      else openFlyout(anchor, onPick, opts);
    });
  } else {
    // クリックの既存動作（即作成など）に進むときは出しかけのフライアウトを片付ける
    anchor.addEventListener("click", closeLocationFlyout);
  }
}

// スタンドアロン表示（+ ボタン・フォームの場所欄）用の後片付け。
// ctx-menu 内のサブメニューはメニュー側の close で DOM ごと消えるが、状態も揃えて戻す
window.addEventListener(
  "mousedown",
  (e) => {
    if (!flyoutEl) return;
    const target = e.target as Node;
    if (flyoutEl.contains(target) || flyoutAnchor?.contains(target)) return;
    closeLocationFlyout();
  },
  true,
);
window.addEventListener(
  "keydown",
  (e) => {
    if (flyoutEl && e.key === "Escape") closeLocationFlyout();
  },
  true,
);
window.addEventListener("blur", closeLocationFlyout);
window.addEventListener("resize", closeLocationFlyout);
