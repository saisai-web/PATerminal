// Git ウィンドウのサイドバー下部: ブランチ / リモート / タグの一覧（git_refs）。
//
// ブランチ名は "/" でフォルダーにまとめたツリーにする（feature/x → feature フォルダー）。
//   - クリック: 先端コミットを履歴で表示（git-log.ts の revealCommit）
//   - ダブルクリック / 右クリック →「チェックアウト」: ローカルはそのブランチへ切り替え、
//     リモートは同名のローカルがあればそれへ、無ければ追跡ブランチを作って切り替える
// 一覧は Git ウィンドウが開いている間だけ git 監視の3秒ポーリングに相乗りして取り直す。
// フォルダーの開閉は画面を閉じても覚えておく（リポジトリが変わったら初期状態へ戻す）。

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { copyText } from "../../shared/clipboard";
import { checkoutRemoteBranch, isActionBusy, switchBranch } from "./git-actions";
import { revealCommit } from "./git-log";

type GitRef = {
  name: string;
  hash: string;
  upstream: string;
  ahead: number;
  behind: number;
  gone: boolean;
  worktree: string;
};
type GitRefs = { head: string | null; local: GitRef[]; remote: GitRef[]; tags: GitRef[] };
type Kind = "local" | "remote" | "tags";

const trees: Record<Kind, HTMLDivElement> = {
  local: document.querySelector<HTMLDivElement>("#gw-branch-tree")!,
  remote: document.querySelector<HTMLDivElement>("#gw-remote-tree")!,
  tags: document.querySelector<HTMLDivElement>("#gw-tag-tree")!,
};
const filterEl = document.querySelector<HTMLInputElement>("#gw-side-filter")!;
const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-gw-refs]"));

let refsBusy = false;
let refsToken = 0;
let refsSig = "";
let refsRoot: string | null = null;
let refs: GitRefs | null = null;
/** 開いているフォルダー（`${kind}:${path}`）。初期状態は「現在のブランチまでの道」と各リモート */
let expanded = new Set<string>();
let selectedKey: string | null = null; // ハイライト中の行（`${kind}:${name}`）

export async function pollRefs(root: string): Promise<void> {
  if (refsBusy) return;
  refsBusy = true;
  const token = ++refsToken;
  try {
    const res = await invoke<GitRefs>("git_refs", { root }).catch(() => null);
    if (token !== refsToken || !res) return;
    if (root !== refsRoot) {
      refsRoot = root;
      selectedKey = null;
      expanded = initialExpanded(res);
    }
    const sig = JSON.stringify(res);
    if (sig === refsSig) return;
    refsSig = sig;
    refs = res;
    render();
  } finally {
    refsBusy = false;
  }
}

/** リポジトリ外へ出たとき */
export function resetSidebar(): void {
  ++refsToken;
  refs = null;
  refsSig = "";
  refsRoot = null;
  for (const el of Object.values(trees)) el.innerHTML = "";
}

export function renderSidebarTexts(): void {
  filterEl.placeholder = t("gw.filter");
  render();
}

function initialExpanded(r: GitRefs): Set<string> {
  const set = new Set<string>();
  const parts = (r.head ?? "").split("/");
  for (let i = 1; i < parts.length; i++) set.add(`local:${parts.slice(0, i).join("/")}`);
  for (const ref of r.remote) set.add(`remote:${ref.name.split("/")[0]}`);
  return set;
}

// ============================================================
// ツリーの組み立て
// ============================================================

type Folder = { name: string; path: string; folders: Map<string, Folder>; leaves: GitRef[] };

function buildFolders(list: GitRef[]): Folder {
  const root: Folder = { name: "", path: "", folders: new Map(), leaves: [] };
  for (const ref of list) {
    const parts = ref.name.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = node.folders.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path, folders: new Map(), leaves: [] };
        node.folders.set(parts[i], next);
      }
      node = next;
    }
    node.leaves.push(ref);
  }
  return root;
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function render(): void {
  if (!refs) return;
  const q = filterEl.value.trim().toLowerCase();
  const match = (r: GitRef): boolean => !q || r.name.toLowerCase().includes(q);
  renderTree("local", refs.local.filter(match), q !== "");
  renderTree("remote", refs.remote.filter(match), q !== "");
  // タグは新しい版が上に来るよう、数値を考慮した降順
  const tags = refs.tags.filter(match).sort((a, b) => byName(b, a));
  const tagEl = trees.tags;
  tagEl.innerHTML = "";
  if (tags.length === 0) tagEl.append(emptyRow());
  for (const tag of tags) tagEl.append(leafRow("tags", tag, 0));
}

function renderTree(kind: Kind, list: GitRef[], filtering: boolean): void {
  const el = trees[kind];
  el.innerHTML = "";
  if (list.length === 0) {
    el.append(emptyRow());
    return;
  }
  const walk = (folder: Folder, depth: number, parent: HTMLElement): void => {
    for (const sub of [...folder.folders.values()].sort(byName)) {
      const key = `${kind}:${sub.path}`;
      const open = filtering || expanded.has(key);
      parent.append(folderRow(key, sub.name, depth, open));
      if (open) walk(sub, depth + 1, parent);
    }
    for (const leaf of folder.leaves.sort(byName)) parent.append(leafRow(kind, leaf, depth));
  };
  walk(buildFolders(list), 0, el);
}

function emptyRow(): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "gw-tree-empty";
  row.textContent = t("gw.none");
  return row;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(paths: string, cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

const CHEVRON = '<path d="m6 4 4 4-4 4"/>';
const FOLDER = '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>';
const TAG = '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.3" cy="5.3" r=".9"/>';

function indent(row: HTMLElement, depth: number): void {
  row.style.setProperty("--depth", String(depth));
}

function folderRow(key: string, name: string, depth: number, open: boolean): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "gw-tree-row gw-tree-folder";
  row.role = "treeitem";
  row.tabIndex = 0;
  row.setAttribute("aria-expanded", String(open));
  indent(row, depth);
  row.append(icon(CHEVRON, "gw-tree-chevron"), icon(FOLDER, "gw-tree-icon"));
  const label = document.createElement("span");
  label.className = "gw-tree-name";
  label.textContent = name;
  row.append(label);
  const toggle = (): void => {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    render();
    [...document.querySelectorAll<HTMLElement>(".gw-tree-folder")]
      .find((r) => r.dataset.key === key)
      ?.focus();
  };
  row.dataset.key = key;
  row.onclick = toggle;
  row.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " " || (e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
      e.preventDefault();
      toggle();
    }
  };
  return row;
}

function leafRow(kind: Kind, ref: GitRef, depth: number): HTMLDivElement {
  const row = document.createElement("div");
  const isCurrent = kind === "local" && ref.name === refs?.head;
  const key = `${kind}:${ref.name}`;
  row.className = `gw-tree-row gw-tree-leaf gw-ref-${kind}`;
  row.classList.toggle("is-current", isCurrent);
  row.classList.toggle("is-selected", key === selectedKey);
  row.role = "treeitem";
  row.tabIndex = 0;
  row.dataset.ref = ref.name;
  indent(row, depth);
  // 現在のブランチは ○、それ以外はフォルダーの矢印ぶんの余白を空けて揃える
  const marker = document.createElement("span");
  marker.className = "gw-tree-marker";
  if (kind === "tags") marker.append(icon(TAG, "gw-tree-icon"));
  row.append(marker);
  const label = document.createElement("span");
  label.className = "gw-tree-name";
  label.textContent = kind === "tags" ? ref.name : ref.name.slice(ref.name.lastIndexOf("/") + 1);
  row.append(label);
  const tips: string[] = [ref.name];
  if (isCurrent) tips.push(t("gw.currentBranch"));
  if (kind === "local") {
    if (ref.ahead) row.append(badge(`↑${ref.ahead}`, "is-ahead"));
    if (ref.behind) row.append(badge(`↓${ref.behind}`, "is-behind"));
    if (ref.upstream) tips.push(`⇄ ${ref.upstream}`);
    if (ref.ahead) tips.push(t("gw.ahead", { n: String(ref.ahead) }));
    if (ref.behind) tips.push(t("gw.behind", { n: String(ref.behind) }));
    if (ref.gone) tips.push(t("gw.upstreamGone"));
    if (ref.worktree && !isCurrent) {
      row.classList.add("in-worktree");
      tips.push(t("gw.inWorktree", { path: ref.worktree }));
    }
  }
  tips.push(ref.hash);
  row.title = tips.join("\n");
  row.onclick = () => {
    selectedKey = key;
    for (const r of document.querySelectorAll(".gw-tree-leaf.is-selected")) r.classList.remove("is-selected");
    row.classList.add("is-selected");
    revealCommit(ref.hash);
  };
  row.ondblclick = (e) => {
    e.preventDefault();
    checkout(kind, ref);
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    openRefMenu(kind, ref, e.clientX, e.clientY);
  };
  row.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      row.click();
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const box = row.getBoundingClientRect();
      openRefMenu(kind, ref, box.left + 16, box.bottom);
    }
  };
  return row;
}

function badge(text: string, cls: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `gw-tree-badge ${cls}`;
  el.textContent = text;
  return el;
}

function canCheckout(kind: Kind, ref: GitRef): boolean {
  if (isActionBusy()) return false;
  if (kind === "local") return ref.name !== refs?.head;
  return kind === "remote";
}

function checkout(kind: Kind, ref: GitRef): void {
  if (!canCheckout(kind, ref)) return;
  if (kind === "local") switchBranch(ref.name);
  else checkoutRemoteBranch(ref.name);
}

// ============================================================
// 右クリックメニュー（チェックアウト / 履歴で表示 / 名前をコピー）
// ============================================================

let menuEl: HTMLDivElement | null = null;

function closeRefMenu(): void {
  menuEl?.remove();
  menuEl = null;
}

function openRefMenu(kind: Kind, ref: GitRef, x: number, y: number): void {
  closeRefMenu();
  const menu = document.createElement("div");
  menu.id = "git-ref-ctx";
  menu.className = "git-ctx-menu";
  menu.role = "menu";
  const title = document.createElement("div");
  title.className = "git-commit-ctx-title";
  title.textContent = ref.name;
  menu.append(title);
  const item = (label: string, onClick: () => void, disabled = false): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.role = "menuitem";
    b.textContent = label;
    b.disabled = disabled;
    b.onclick = () => {
      closeRefMenu();
      onClick();
    };
    menu.append(b);
  };
  if (kind !== "tags") item(t("gw.checkout"), () => checkout(kind, ref), !canCheckout(kind, ref));
  item(t("gw.showInHistory"), () => revealCommit(ref.hash));
  item(t("gw.copyName"), () => void copyText(ref.name));
  document.body.append(menu);
  menuEl = menu;
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

window.addEventListener(
  "mousedown",
  (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeRefMenu();
  },
  true,
);
window.addEventListener(
  "keydown",
  (e) => {
    if (menuEl && e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault(); // Git ウィンドウは閉じない
      closeRefMenu();
    }
  },
  true,
);
window.addEventListener("blur", closeRefMenu);
window.addEventListener("resize", closeRefMenu);

// ============================================================
// セクションの開閉とフィルター
// ============================================================

for (const section of sections) {
  const head = section.querySelector<HTMLElement>(".gw-side-title")!;
  head.tabIndex = 0;
  head.role = "button";
  head.setAttribute("aria-expanded", "true");
  const toggle = (): void => {
    const collapsed = section.classList.toggle("is-collapsed");
    head.setAttribute("aria-expanded", String(!collapsed));
  };
  head.onclick = toggle;
  head.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };
}

filterEl.addEventListener("input", render);
filterEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && filterEl.value) {
    e.preventDefault();
    filterEl.value = "";
    render();
  }
});
