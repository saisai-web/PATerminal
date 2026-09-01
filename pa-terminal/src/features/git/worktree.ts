// worktree まわりの共有部品。作成モーダル（agent-panel）と Issue 実行フォーム・
// エクスプローラー下部の Worktree タブ（git-panel）から使う。
//
// - 作成先は「リポジトリ外」（既定・絶対パス / ~ / .. を許可・.gitignore は触らない）と
//   「リポジトリ配下」（ルートの .gitignore へ自動追記）の2モード。
//   最後に使ったモードとパス、Issue 実行で選んだベースブランチは
//   session.json の settings.worktree に保存する
// - 一覧と削除は同じ描画関数を両方の置き場所で共有する。削除は「×→行内で確認→通常削除、
//   失敗したときだけ強制削除」の2段階（window.confirm は WKWebView で使わない方針）
// - ローカルブランチを持つ行は、open Issue をその場で選んで linked branch 化できる。
//   Issue の取得は操作した時だけで、一覧の描画や git ポーリングには相乗りさせない
//
// 色は必ず CSS 変数経由（テーマ切替から漏れるため hex ハードコード禁止）。

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import type { IssueBranchLink, IssueList, IssueSummary } from "./git-panel-types";

export type WorktreeBranch = { name: string; reference: string; current: boolean };
export type WorktreeBranches = { branches: WorktreeBranch[] };
export type WorktreeResult = { path: string; branch: string; reused: boolean };

export type WorktreeEntry = {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  isCurrent: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason: string;
  missing: boolean;
};
export type WorktreeList = { entries: WorktreeEntry[] };

type WorktreeListDeps = {
  /** 一覧で選んだ worktree を通常シェルの新規セッションで開く */
  openSession: (args: { name: string; cwd: string }) => void;
};

let listDeps: WorktreeListDeps = { openSession: () => {} };

export function initWorktreeList(deps: WorktreeListDeps): void {
  listDeps = deps;
}

/** Rust の worktree_dir_name と同じ規則で、作成先のプレビュー名を作る。 */
export function worktreeDirName(branch: string): string {
  let out = "";
  let dash = false;
  for (const ch of branch) {
    if (/^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
      dash = false;
    } else if (!dash) {
      out += "-";
      dash = true;
    }
  }
  return out.replace(/^[._-]+|[._-]+$/g, "").slice(0, 100);
}

// ============================================================
// 作成先の設定（session.json の settings.worktree に保存）
// ============================================================

export type WorktreeLocation = "inside" | "outside";
export type WorktreePrefs = {
  location: WorktreeLocation;
  /** リポジトリ配下モードの格納先（ルートからの相対） */
  insideDir: string;
  /** リポジトリ外モードの格納先（絶対パス / ~ / ..） */
  outsideDir: string;
  /** Issue 実行で最後にユーザーが選んだベースブランチの完全な ref */
  issueBaseRef?: string;
};

const DEFAULT_PREFS: WorktreePrefs = {
  location: "outside",
  insideDir: ".worktree",
  outsideDir: "~/worktrees",
};

let prefs: WorktreePrefs = { ...DEFAULT_PREFS };
let onPrefsChange: (() => void) | null = null;

export function initWorktreePrefs(opts: { onChange: () => void }): void {
  onPrefsChange = opts.onChange;
}

export function getWorktreePrefs(): WorktreePrefs {
  return { ...prefs };
}

/** session.json から復元。壊れた値・空文字は既定へ落とす（マイグレーションは書かない）。 */
export function setWorktreePrefs(value: unknown): void {
  const saved = (value ?? {}) as Partial<Record<keyof WorktreePrefs, unknown>>;
  const dir = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() && v.length <= 512 ? v.trim() : fallback;
  prefs = {
    // 明示的に "inside" を保存してある場合だけ配下モード。未設定・壊れた値は既定の外側へ
    location: saved.location === "inside" ? "inside" : "outside",
    insideDir: dir(saved.insideDir, DEFAULT_PREFS.insideDir),
    outsideDir: dir(saved.outsideDir, DEFAULT_PREFS.outsideDir),
    issueBaseRef: dir(saved.issueBaseRef, "") || undefined,
  };
}

/** 作成に成功したときの記憶。変更があったときだけ保存を走らせる。 */
export function updateWorktreePrefs(patch: Partial<WorktreePrefs>): void {
  const next = { ...prefs, ...patch };
  if (
    next.location === prefs.location &&
    next.insideDir === prefs.insideDir &&
    next.outsideDir === prefs.outsideDir &&
    next.issueBaseRef === prefs.issueBaseRef
  ) {
    return;
  }
  prefs = next;
  onPrefsChange?.();
}

/** そのモードで使う既定の格納先。 */
export function worktreeDirFor(location: WorktreeLocation): string {
  return location === "outside" ? prefs.outsideDir : prefs.insideDir;
}

/**
 * 作成される場所のプレビュー。実際の解決（~ 展開・.. の畳み込み）は Rust 側が行うので、
 * ここでは打った文字をそのまま組み立てて見せる。
 */
export function worktreePreviewPath(
  root: string,
  location: WorktreeLocation,
  directory: string,
  branch: string,
): string {
  const base = root.replace(/[\\/]+$/, "");
  const dir = directory.trim();
  const leaf = worktreeDirName(branch.trim()) || "…";
  if (location === "outside") {
    if (!dir) return base;
    // 絶対パス・~ 始まりはそのまま、相対はリポジトリルート基準
    const head = /^([/\\]|~|[A-Za-z]:)/.test(dir) ? dir : `${base}/${dir}`;
    return `${head.replace(/[\\/]+$/, "")}/${leaf}`;
  }
  const parts = [dir, leaf].filter(Boolean).join("/");
  return base && parts ? `${base}/${parts}` : base;
}

// ============================================================
// 一覧と削除
// ============================================================

/** どのコンテナが今どの root を描いているか。再取得の取り違えを防ぐ */
const listRoots = new WeakMap<HTMLElement, string | null>();
const listTokens = new WeakMap<HTMLElement, number>();
const listSessionActions = new WeakMap<HTMLElement, boolean>();

/**
 * 一括削除の失敗を、削除後の再描画をまたいで引き継ぐ。描き直した一覧で失敗した行だけを
 * 選択したまま復元し、操作バーにエラーと強制削除ボタンを出す。
 */
type BulkFailure = { path: string; error: string };
const pendingBulk = new WeakMap<HTMLElement, BulkFailure[]>();

function shortLabel(entry: WorktreeEntry): string {
  if (entry.branch) return entry.branch;
  if (entry.bare) return "(bare)";
  return entry.head || "(detached)";
}

function addTag(row: HTMLElement, text: string, kind?: "warn"): void {
  const tag = document.createElement("span");
  tag.className = "wt-tag" + (kind === "warn" ? " is-warn" : "");
  tag.textContent = text;
  row.append(tag);
}

function issueOptionLabel(issue: IssueSummary): string {
  return `#${issue.number} ${issue.title}`;
}

function addSessionAction(entry: WorktreeEntry, actions: HTMLDivElement): void {
  const open = document.createElement("button");
  open.type = "button";
  open.className = "wt-session-open";
  open.textContent = t("issue.runSession");
  open.title = t("issue.runSession");
  // bare リポジトリと欠損登録には、シェルを開始できる作業ディレクトリがない。
  open.disabled = entry.bare || entry.missing;
  open.onclick = () => {
    listDeps.openSession({ name: shortLabel(entry), cwd: entry.path });
  };
  actions.append(open);
}

/**
 * worktree のローカルブランチを、後から選んだ GitHub Issue の linked branch にする。
 * ネットワークアクセスはボタンを押した時だけ行い、閉じた Issue は二重に除外する。
 */
function addIssueLinkAction(
  row: HTMLDivElement,
  root: string,
  entry: WorktreeEntry,
  actions: HTMLDivElement,
): void {
  const open = document.createElement("button");
  open.type = "button";
  open.className = "wt-issue-open";
  open.textContent = t("git.issues");
  open.title = t("issue.linkTitle");
  actions.append(open);

  let panel: HTMLDivElement | null = null;
  let requestToken = 0;
  const close = () => {
    requestToken++;
    panel?.remove();
    panel = null;
    open.disabled = false;
  };

  open.onclick = async () => {
    if (panel) return;
    open.disabled = true;
    const token = ++requestToken;
    const nextPanel = document.createElement("div");
    nextPanel.className = "wt-issue-link";
    panel = nextPanel;

    const status = document.createElement("div");
    status.className = "wt-issue-status";
    status.textContent = t("issue.loading");
    const controls = document.createElement("div");
    controls.className = "wt-actions wt-issue-controls";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("wt.confirmCancel");
    cancel.onclick = close;
    controls.append(cancel);
    nextPanel.append(status, controls);
    actions.after(nextPanel);

    const result = await invoke<IssueList>("issue_list", { root }).catch(() => null);
    if (token !== requestToken || panel !== nextPanel || !row.isConnected) return;
    if (!result?.available) {
      status.classList.add("is-error");
      status.textContent = t("issue.loadFailed");
      return;
    }
    const issues = result.issues.filter(
      (issue) => (issue.state ?? "").toUpperCase() !== "CLOSED",
    );
    if (issues.length === 0) {
      status.textContent = t("issue.empty");
      return;
    }

    const select = document.createElement("select");
    select.title = t("git.issues");
    for (const issue of issues) {
      const option = document.createElement("option");
      option.value = String(issue.number);
      option.textContent = issueOptionLabel(issue);
      select.append(option);
    }
    const link = document.createElement("button");
    link.type = "button";
    link.className = "wt-issue-link-action";
    link.textContent = t("issue.linkAction");
    controls.prepend(select, link);
    status.textContent = t("issue.linkHint");

    link.onclick = async () => {
      const number = Number(select.value);
      if (!Number.isSafeInteger(number) || number <= 0) return;
      for (const el of [select, link, cancel]) el.disabled = true;
      status.classList.remove("is-error", "is-success");
      status.textContent = t("issue.linking");
      try {
        const linked = await invoke<IssueBranchLink>("issue_link_branch", {
          root,
          number,
          branch: entry.branch,
        });
        status.classList.add("is-success");
        status.textContent = t("issue.linkSuccess", {
          branch: linked.branch,
          number: String(number),
          remote: linked.remote,
        });
      } catch (e) {
        status.classList.add("is-error");
        status.textContent = t("issue.linkFailed", { error: String(e) });
      } finally {
        for (const el of [select, link, cancel]) el.disabled = false;
      }
    };
  };
}

function messageRow(container: HTMLElement, text: string, isError = false): void {
  const row = document.createElement("div");
  row.className = "wt-empty" + (isError ? " is-error" : "");
  row.textContent = text;
  container.append(row);
}

/**
 * `container` の中身を worktree 一覧で描き替える。root が null / 取得失敗のときは
 * その旨の1行だけを出す。
 */
export async function renderWorktreeList(
  container: HTMLElement,
  root: string | null,
  options?: { showSessionAction?: boolean },
): Promise<void> {
  listRoots.set(container, root);
  if (options) listSessionActions.set(container, options.showSessionAction === true);
  const token = (listTokens.get(container) ?? 0) + 1;
  listTokens.set(container, token);
  if (!root) {
    container.textContent = "";
    messageRow(container, t("wt.noRepo"));
    return;
  }
  container.textContent = "";
  messageRow(container, t("wt.loading"));
  let entries: WorktreeEntry[];
  try {
    entries = (await invoke<WorktreeList>("git_worktree_list", { root })).entries;
  } catch (e) {
    if (listTokens.get(container) !== token) return;
    container.textContent = "";
    messageRow(container, t("wt.loadFailed", { error: String(e) }), true);
    return;
  }
  if (listTokens.get(container) !== token) return;
  container.textContent = "";
  const failures = pendingBulk.get(container) ?? [];
  pendingBulk.delete(container);
  if (entries.length === 0) {
    messageRow(container, t("wt.empty"));
    return;
  }
  // 一覧の行より前に、選択と一括削除の1行（操作バー）を置く
  const bar = buildBulkBar(container, root);
  container.append(bar.el);
  const failed = new Set(failures.map((f) => f.path));
  for (const entry of entries) {
    container.append(buildWorktreeRow(
      container,
      root,
      entry,
      bar.onSelectionChange,
      failed.has(entry.path),
      listSessionActions.get(container) === true,
    ));
  }
  bar.refresh(failures);
  const hint = document.createElement("div");
  hint.className = "wt-hint";
  hint.textContent = t("wt.branchKeptHint");
  container.append(hint);
}

/** 削除できる行のチェックボックス（メイン・現在の worktree には無い） */
function selectionBoxes(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>(".wt-check")];
}

/**
 * 一覧の先頭に置く操作バー。全選択チェックと「選択したN件を削除」ボタンだけの1行で、
 * 削除は行内と同じく「押す → 同じ行で確認 → 実行」の2段階。失敗したものが残ったときだけ
 * 理由と強制削除ボタンを足す。
 */
function buildBulkBar(
  container: HTMLElement,
  root: string,
): { el: HTMLDivElement; refresh: (failures: BulkFailure[]) => void; onSelectionChange: () => void } {
  const el = document.createElement("div");
  el.className = "wt-bar";

  const all = document.createElement("label");
  all.className = "wt-bar-all";
  const allBox = document.createElement("input");
  allBox.type = "checkbox";
  const allText = document.createElement("span");
  allText.textContent = t("wt.selectAll");
  all.append(allBox, allText);

  const actions = document.createElement("div");
  actions.className = "wt-actions";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "wt-bulk-del";

  const confirm = document.createElement("div");
  confirm.className = "wt-confirm";
  confirm.hidden = true;
  const question = document.createElement("span");
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "wt-yes is-danger";
  yes.textContent = t("wt.confirmDelete");
  const no = document.createElement("button");
  no.type = "button";
  no.className = "wt-no";
  no.textContent = t("wt.confirmCancel");
  confirm.append(question, yes, no);

  const force = document.createElement("button");
  force.type = "button";
  force.className = "wt-force is-danger";
  force.textContent = t("wt.forceRemove");
  force.hidden = true;

  actions.append(del, confirm, force);
  el.append(all, actions);

  const error = document.createElement("div");
  error.className = "wt-error wt-bulk-error";
  error.hidden = true;
  el.append(error);

  let failedPaths: string[] = [];
  const selected = () => selectionBoxes(container).filter((b) => b.checked);
  const busy = (on: boolean) => {
    for (const b of [del, yes, no, force]) b.disabled = on;
    allBox.disabled = on;
    for (const b of selectionBoxes(container)) b.disabled = on;
  };
  const arm = (open: boolean) => {
    del.hidden = open;
    confirm.hidden = !open;
    if (open) question.textContent = t("wt.confirmBulk", { count: String(selected().length) });
  };
  const sync = () => {
    const boxes = selectionBoxes(container);
    const count = boxes.filter((b) => b.checked).length;
    allBox.checked = count > 0 && count === boxes.length;
    allBox.indeterminate = count > 0 && count < boxes.length;
    del.disabled = count === 0;
    del.textContent =
      count === 0 ? t("wt.removeSelected") : t("wt.removeSelectedCount", { count: String(count) });
    if (count === 0) arm(false);
    else if (!confirm.hidden) question.textContent = t("wt.confirmBulk", { count: String(count) });
  };

  const run = async (useForce: boolean) => {
    const paths = useForce ? failedPaths : selected().map((b) => b.value);
    if (paths.length === 0) return;
    busy(true);
    const failures: BulkFailure[] = [];
    // 直列に消す（並列 invoke で git を同時に叩かない。1件失敗しても残りは続ける）
    for (const path of paths) {
      try {
        await invoke("git_worktree_remove", { root, path, force: useForce });
      } catch (e) {
        failures.push({ path, error: String(e) });
      }
    }
    if (failures.length > 0) pendingBulk.set(container, failures);
    await renderWorktreeList(container, listRoots.get(container) ?? root);
  };

  allBox.onchange = () => {
    for (const b of selectionBoxes(container)) b.checked = allBox.checked;
    sync();
  };
  del.onclick = () => arm(true);
  no.onclick = () => arm(false);
  yes.onclick = () => void run(false);
  force.onclick = () => void run(true);

  return {
    el,
    onSelectionChange: sync,
    refresh: (failures) => {
      const boxes = selectionBoxes(container);
      // 削除できる行が無ければバーごと出さない（メイン + 現在だけの一覧）
      el.hidden = boxes.length === 0;
      failedPaths = failures.map((f) => f.path);
      force.hidden = failures.length === 0;
      error.hidden = failures.length === 0;
      if (failures.length > 0) {
        error.textContent = [
          t("wt.bulkFailed", { count: String(failures.length) }),
          ...failures.map((f) => `${f.path}: ${f.error}`),
        ].join("\n");
      }
      sync();
    },
  };
}

function buildWorktreeRow(
  container: HTMLElement,
  root: string,
  entry: WorktreeEntry,
  onSelectionChange: () => void,
  preselected: boolean,
  showSessionAction: boolean,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "wt-row";
  row.title = entry.path;

  const head = document.createElement("div");
  head.className = "wt-head";
  const name = document.createElement("span");
  name.className = "wt-branch";
  name.textContent = `⎇ ${shortLabel(entry)}`;
  head.append(name);
  if (entry.isMain) addTag(head, t("wt.main"));
  if (entry.isCurrent) addTag(head, t("wt.current"));
  if (entry.locked) addTag(head, t("wt.locked"), "warn");
  if (entry.missing) addTag(head, t("wt.missing"), "warn");

  const path = document.createElement("div");
  path.className = "wt-path";
  path.textContent = entry.path;

  const actions = document.createElement("div");
  actions.className = "wt-actions";
  row.append(head, path, actions);

  // worktree は GitHub 上の概念ではないため、対応するローカルブランチを Issue に紐付ける。
  // detached / bare は linked branch にできないので操作自体を出さない。
  if (entry.branch && !entry.detached && !entry.bare) {
    addIssueLinkAction(row, root, entry, actions);
  }
  if (showSessionAction) {
    // 右下の Worktree タブでは、Issue の右隣から通常セッションを直接開ける。
    addSessionAction(entry, actions);
  }

  // メインと現在の worktree は消せない（Rust 側でも拒否する）
  if (entry.isMain || entry.isCurrent) return row;

  // 一括削除の対象チェック。値はパスなので、バー側は DOM から選択を読むだけで済む
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "wt-check";
  check.value = entry.path;
  check.checked = preselected;
  check.title = t("wt.selectRow", { name: shortLabel(entry) });
  check.onchange = onSelectionChange;
  head.prepend(check);

  const error = document.createElement("div");
  error.className = "wt-error";
  error.hidden = true;

  const del = document.createElement("button");
  del.type = "button";
  del.className = "wt-del";
  del.textContent = "×";
  del.title = t("wt.removeTitle");

  const confirm = document.createElement("div");
  confirm.className = "wt-confirm";
  confirm.hidden = true;
  const question = document.createElement("span");
  question.textContent = t("wt.confirm", { name: shortLabel(entry) });
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "wt-yes is-danger";
  yes.textContent = t("wt.confirmDelete");
  const no = document.createElement("button");
  no.type = "button";
  no.className = "wt-no";
  no.textContent = t("wt.confirmCancel");
  confirm.append(question, yes, no);

  const force = document.createElement("button");
  force.type = "button";
  force.className = "wt-force is-danger";
  force.textContent = t("wt.forceRemove");
  force.hidden = true;

  actions.append(del, confirm, force);
  row.append(error);

  const arm = (open: boolean) => {
    del.hidden = open;
    confirm.hidden = !open;
    if (!open) {
      error.hidden = true;
      force.hidden = true;
    }
  };
  const busy = (on: boolean) => {
    for (const b of [del, yes, no, force]) b.disabled = on;
  };
  const run = async (useForce: boolean) => {
    busy(true);
    try {
      await invoke("git_worktree_remove", { root, path: entry.path, force: useForce });
      // 消えた行を含めて全体を取り直す（prune で他の行の状態も変わり得る）
      await renderWorktreeList(container, listRoots.get(container) ?? root);
    } catch (e) {
      busy(false);
      error.textContent = String(e);
      error.hidden = false;
      // 通常削除で失敗したときだけ強制削除を出す（2度目の明示操作を必ず挟む）
      force.hidden = useForce;
      confirm.hidden = true;
      del.hidden = false;
    }
  };

  del.onclick = () => arm(true);
  no.onclick = () => arm(false);
  yes.onclick = () => void run(false);
  force.onclick = () => void run(true);
  return row;
}

/** 言語切替時に、開いている一覧の文言を貼り直す。 */
export function renderWorktreeListTexts(containers: HTMLElement[]): void {
  for (const container of containers) {
    if (container.hidden || !container.childElementCount) continue;
    void renderWorktreeList(container, listRoots.get(container) ?? null);
  }
}
