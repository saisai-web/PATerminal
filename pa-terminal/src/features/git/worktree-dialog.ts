// ============================================================
// Worktreeモーダル（作成元・新規ブランチ・格納先を選択）
//
// 作成元は2通り:
//   - ブランチ … 選んだブランチを起点に新しいブランチ + worktree を作る
//   - PR       … open な PR の head ブランチで worktree を用意する（`pr_list` は
//                このモードに切り替えた時だけ1回取る。定期取得はしない）
// どちらも作成 / 再利用できた worktree をそのままセッションとして開く。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import type { PrList, PrSummary } from "./git-panel-types";
import { getGitRoot } from "./agent-panel";
import { isActionBusy, runGitAction } from "./git-actions";
import { t } from "../../i18n";
import { isPullDialogOpen } from "./pull-dialog";
import { createWorktreeProgress, worktreeResultMessage } from "./worktree-progress";
import {
  defaultBaseRef,
  getWorktreePrefs,
  renderWorktreeList,
  renderWorktreeListTexts,
  updateWorktreePrefs,
  worktreeDirFor,
  worktreePreviewPath,
} from "./worktree";
import type { WorktreeBranches, WorktreeLocation, WorktreeResult } from "./worktree";

type WorktreeDialogDeps = {
  /** 作成・再利用した worktree を通常シェルの新規セッションで開く */
  openSession: (args: { name: string; cwd: string }) => void;
};

let deps: WorktreeDialogDeps = { openSession: () => {} };

export function initWorktreeDialog(d: WorktreeDialogDeps): void {
  deps = d;
}

const worktreeBtn = document.querySelector<HTMLButtonElement>("#git-worktree")!;
const worktreeOverlay = document.querySelector<HTMLDivElement>("#worktree-overlay")!;
const worktreePanel = document.querySelector<HTMLDivElement>("#worktree-panel")!;
const worktreeCloseBtn = document.querySelector<HTMLButtonElement>("#worktree-close")!;
const worktreeRootEl = document.querySelector<HTMLOutputElement>("#worktree-root")!;
const worktreeBaseSel = document.querySelector<HTMLSelectElement>("#worktree-base")!;
const worktreeBranchEl = document.querySelector<HTMLInputElement>("#worktree-branch")!;
const worktreeDirectoryEl = document.querySelector<HTMLInputElement>("#worktree-directory")!;
const worktreeDirLabelEl = document.querySelector<HTMLSpanElement>("#worktree-directory-label")!;
const worktreeLocRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>("#worktree-loc input[type=radio]"),
);
const worktreeInheritRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>("#worktree-inherit input[type=radio]"),
);
const worktreeIgnoreHintEl = document.querySelector<HTMLParagraphElement>("#worktree-ignore-hint")!;
const worktreeExternalHintEl =
  document.querySelector<HTMLParagraphElement>("#worktree-external-hint")!;
const worktreeListEl = document.querySelector<HTMLDivElement>("#worktree-list")!;
const worktreeLocationEl = document.querySelector<HTMLOutputElement>("#worktree-location")!;
const worktreeErrorEl = document.querySelector<HTMLDivElement>("#worktree-error")!;
const worktreeCancelBtn = document.querySelector<HTMLButtonElement>("#worktree-cancel")!;
const worktreeSubmitBtn = document.querySelector<HTMLButtonElement>("#worktree-submit")!;
const worktreeSourceRadios = Array.from(
  document.querySelectorAll<HTMLInputElement>("#worktree-source input[type=radio]"),
);
const worktreeBaseField = document.querySelector<HTMLLabelElement>("#worktree-base-field")!;
const worktreeBranchField = document.querySelector<HTMLLabelElement>("#worktree-branch-field")!;
const worktreePrField = document.querySelector<HTMLLabelElement>("#worktree-pr-field")!;
const worktreePrSel = document.querySelector<HTMLSelectElement>("#worktree-pr")!;
const worktreePrHintEl = document.querySelector<HTMLParagraphElement>("#worktree-pr-hint")!;
// 作成中のローディング。worktree add → 環境ファイルのコピー（進捗は worktree:inherit イベント）
const worktreeProgress = createWorktreeProgress(worktreePanel, "worktree");

type WorktreeSource = "branch" | "pr";

let worktreeDialogRoot: string | null = null;
/** 変更ストリップの Worktree ボタンから開いたか（PR 側から開いたときは false） */
let worktreeFollowsStrip = false;
let worktreeBeforeOpenSession: (() => void) | null = null;
let worktreeLoading = false;
let worktreeLoadToken = 0;
/** PR モードで選べる open な PR。null は「まだ取っていない」 */
let worktreePrs: PrSummary[] | null = null;
let worktreePrLoading = false;
let worktreePrToken = 0;
export function isWorktreeDialogOpen(): boolean {
  return !worktreeOverlay.hidden;
}

export function getWorktreeDialogRoot(): string | null {
  return worktreeDialogRoot;
}

/**
 * 変更ストリップが見るリポジトリが変わったら、ストリップから開いたモーダルは閉じる
 * （別リポジトリに対して作らせない）。PR 画面から開いたモーダルは Git パネル側の
 * リポジトリに紐づくので、ストリップの root（別ペインの cwd や未検出の null）では閉じない。
 */
export function syncWorktreeDialogWithStrip(stripRoot: string | null): void {
  if (!isWorktreeDialogOpen() || !worktreeFollowsStrip) return;
  if (stripRoot !== worktreeDialogRoot) closeWorktreeDialog();
}

/** PR 画面から root を指定して開いたモーダルを、その root の画面が閉じるときに一緒に閉じる */
export function closeWorktreeDialogForRoot(root: string | null): void {
  if (!isWorktreeDialogOpen() || worktreeFollowsStrip) return;
  if (root !== null && root === worktreeDialogRoot) closeWorktreeDialog();
}

function worktreeLocationMode(): WorktreeLocation {
  return worktreeLocRadios.find((r) => r.checked)?.value === "outside" ? "outside" : "inside";
}

/** 作成元の gitignore 対象（.env / node_modules など）を新しい worktree へコピーするか */
function worktreeInheritMode(): boolean {
  return worktreeInheritRadios.find((r) => r.checked)?.value !== "no";
}

function worktreeSourceMode(): WorktreeSource {
  return worktreeSourceRadios.find((r) => r.checked)?.value === "pr" ? "pr" : "branch";
}

/** PR モードで選択中の PR（一覧が空 / 未取得のときは null） */
function selectedPr(): PrSummary | null {
  const number = Number(worktreePrSel.value);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return worktreePrs?.find((pr) => pr.number === number) ?? null;
}

/** そのモードで worktree に入るブランチ名（プレビューと作成先の決定に使う） */
function worktreeBranchName(): string {
  return worktreeSourceMode() === "pr"
    ? selectedPr()?.headRefName ?? ""
    : worktreeBranchEl.value;
}

function updateWorktreePreview(): void {
  const root = worktreeDialogRoot ?? "";
  worktreeLocationEl.textContent = root
    ? worktreePreviewPath(
        root,
        worktreeLocationMode(),
        worktreeDirectoryEl.value,
        worktreeBranchName(),
      )
    : root;
}

/** 作成元ラジオに合わせて、ブランチ用とPR用の入力を出し分ける。 */
function applyWorktreeSourceMode(): void {
  const pr = worktreeSourceMode() === "pr";
  worktreeBaseField.hidden = pr;
  worktreeBranchField.hidden = pr;
  worktreePrField.hidden = !pr;
  worktreePrHintEl.hidden = !pr;
  updateWorktreePreview();
}

/**
 * PR 一覧の取得。モーダルを開いている間に PR モードへ切り替えた最初の1回だけ走る
 * （gh はネットワークへ出るので、モーダルの開閉や定期処理には乗せない）。
 */
async function loadWorktreePrs(root: string): Promise<void> {
  if (worktreePrs !== null || worktreePrLoading) return;
  worktreePrLoading = true;
  const token = ++worktreePrToken;
  renderWorktreePrOptions();
  updateWorktreeDialog();
  const res = await invoke<PrList>("pr_list", { root }).catch(
    (e): PrList => ({ available: false, prs: [], error: String(e) }),
  );
  if (token !== worktreePrToken || worktreeDialogRoot !== root || worktreeOverlay.hidden) return;
  worktreePrLoading = false;
  if (res.available) {
    // 一覧と同じく open な PR だけを対象にする
    worktreePrs = res.prs.filter((pr) => (pr.state ?? "").toUpperCase() === "OPEN");
  } else {
    worktreePrs = null;
    worktreeErrorEl.textContent = t("agent.worktreePrFailed", {
      error: res.error?.trim() || t("pr.loadFailedUnknown"),
    });
    worktreeErrorEl.hidden = false;
  }
  renderWorktreePrOptions();
  updateWorktreeDialog();
}

/** PR セレクトの中身。読み込み中・0件は選べない1行だけを出す。 */
function renderWorktreePrOptions(): void {
  const previous = worktreePrSel.value;
  worktreePrSel.replaceChildren();
  const placeholder = (text: string) => {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = text;
    opt.disabled = true;
    opt.selected = true;
    worktreePrSel.append(opt);
  };
  if (worktreePrLoading) {
    placeholder(t("agent.worktreePrLoading"));
    return;
  }
  if (!worktreePrs || worktreePrs.length === 0) {
    placeholder(t("agent.worktreePrEmpty"));
    return;
  }
  for (const pr of worktreePrs) {
    const opt = document.createElement("option");
    opt.value = String(pr.number);
    opt.textContent = `#${pr.number} ${pr.title}`;
    opt.title = `${pr.headRefName} → ${pr.baseRefName}`;
    worktreePrSel.append(opt);
  }
  if (previous && worktreePrs.some((pr) => String(pr.number) === previous)) {
    worktreePrSel.value = previous;
  }
}

/** 置き場所ラジオに合わせてラベル・placeholder・ヒント・プレビューを揃える。 */
function applyWorktreeLocationMode(): void {
  const outside = worktreeLocationMode() === "outside";
  worktreeDirLabelEl.textContent = t(
    outside ? "agent.worktreeDirectoryExternal" : "agent.worktreeDirectory",
  );
  worktreeDirectoryEl.placeholder = outside ? "~/worktrees" : ".worktree";
  worktreeIgnoreHintEl.hidden = outside;
  worktreeExternalHintEl.hidden = !outside;
  updateWorktreePreview();
}

/** 言語切替時（表示中のときだけ）: 格納先ラベルはモードで変わるので data-i18n では貼れない */
export function renderWorktreeDialogTexts(): void {
  applyWorktreeLocationMode();
  renderWorktreePrOptions();
  renderWorktreeListTexts([worktreeListEl]);
}

export function updateWorktreeDialog(): void {
  const disabled = isActionBusy() || worktreeLoading;
  worktreeBaseSel.disabled = disabled;
  worktreeBranchEl.disabled = disabled;
  worktreePrSel.disabled = disabled || worktreePrLoading;
  worktreeDirectoryEl.disabled = disabled;
  for (const radio of [...worktreeLocRadios, ...worktreeSourceRadios, ...worktreeInheritRadios]) {
    radio.disabled = disabled;
  }
  worktreeCloseBtn.disabled = isActionBusy();
  worktreeCancelBtn.disabled = isActionBusy();
  const ready = worktreeSourceMode() === "pr"
    ? Boolean(selectedPr())
    : Boolean(worktreeBaseSel.value && worktreeBranchEl.value.trim());
  worktreeSubmitBtn.disabled = disabled
    || !worktreeDialogRoot
    || !ready
    || !worktreeDirectoryEl.value.trim();
  updateWorktreePreview();
}

type WorktreeDialogOptions = {
  /** 対象リポジトリ。省略時は変更ストリップが見ているリポジトリ */
  root?: string;
  /**
   * PR モードで開く。一覧は呼び出し側が持っている open な PR をそのまま使い
   * （gh を呼び直さない）、number の PR を選択した状態にする。
   */
  pr?: { prs: PrSummary[]; number: number };
  /** 作成に成功してセッションを開く直前に呼ぶ（呼び出し元の画面を閉じるため） */
  beforeOpenSession?: () => void;
};

/**
 * Worktree モーダルを開く。変更ストリップの Worktree ボタン、PR 一覧・詳細の
 * 「新規セッション」が共有する。どこから開いてもベースブランチは既定ブランチ、
 * 置き場所ラジオと読み込み中の無効化は同じ画面で出る。
 */
export async function openWorktreeDialog(options: WorktreeDialogOptions = {}): Promise<void> {
  const root = options.root ?? getGitRoot();
  if (!root || isActionBusy()) return;
  worktreeDialogRoot = root;
  worktreeFollowsStrip = options.root === undefined;
  worktreeBeforeOpenSession = options.beforeOpenSession ?? null;
  worktreeRootEl.textContent = root;
  worktreeBaseSel.innerHTML = "";
  worktreeBranchEl.value = "";
  // PR 一覧はリポジトリごとに取り直す（開くたびに gh は呼ばず、PR モードに入った時だけ）。
  // PR 側から開いたときはその一覧を種にして gh を呼ばない
  ++worktreePrToken;
  worktreePrLoading = false;
  worktreePrs = options.pr
    ? options.pr.prs.filter((pr) => (pr.state ?? "").toUpperCase() === "OPEN")
    : null;
  const source: WorktreeSource = options.pr ? "pr" : "branch";
  for (const radio of worktreeSourceRadios) radio.checked = radio.value === source;
  renderWorktreePrOptions();
  if (options.pr) worktreePrSel.value = String(options.pr.number);
  applyWorktreeSourceMode();
  // 前回使った置き場所を復元する（settings.worktree に保存してある）
  const prefs = getWorktreePrefs();
  for (const radio of worktreeLocRadios) radio.checked = radio.value === prefs.location;
  for (const radio of worktreeInheritRadios) radio.checked = (radio.value === "yes") === prefs.inherit;
  worktreeDirectoryEl.value = worktreeDirFor(prefs.location);
  applyWorktreeLocationMode();
  worktreeErrorEl.hidden = true;
  worktreeLoading = true;
  updateWorktreeDialog();
  worktreeOverlay.hidden = false;
  void renderWorktreeList(worktreeListEl, root);
  const token = ++worktreeLoadToken;
  try {
    const result = await invoke<WorktreeBranches>("git_worktree_branches", { root });
    if (token !== worktreeLoadToken || worktreeDialogRoot !== root || worktreeOverlay.hidden) return;
    for (const branch of result.branches) {
      const opt = document.createElement("option");
      opt.value = branch.reference;
      opt.textContent = branch.name;
      worktreeBaseSel.append(opt);
    }
    // 作業中のブランチではなく、リポジトリの既定ブランチを起点にする
    worktreeBaseSel.value = defaultBaseRef(result);
    if (result.branches.length === 0) {
      worktreeErrorEl.textContent = t("agent.worktreeNoBranches");
      worktreeErrorEl.hidden = false;
    }
  } catch (e) {
    if (token !== worktreeLoadToken || worktreeDialogRoot !== root || worktreeOverlay.hidden) return;
    worktreeErrorEl.textContent = String(e);
    worktreeErrorEl.hidden = false;
  } finally {
    if (token === worktreeLoadToken && worktreeDialogRoot === root && !worktreeOverlay.hidden) {
      worktreeLoading = false;
      updateWorktreeDialog();
      requestAnimationFrame(() => {
        (worktreeSourceMode() === "pr" ? worktreePrSel : worktreeBranchEl).focus();
      });
    }
  }
}

export function closeWorktreeDialog(): void {
  if (isActionBusy()) return;
  ++worktreeLoadToken;
  ++worktreePrToken;
  worktreeLoading = false;
  worktreePrLoading = false;
  worktreeOverlay.hidden = true;
  worktreeDialogRoot = null;
  worktreeBeforeOpenSession = null;
  // PR 画面など別の場所から開いたときは、そちらの focus を奪わない
  if (worktreeBtn.offsetParent !== null && !worktreeBtn.disabled) worktreeBtn.focus();
}

worktreeBtn.onclick = () => void openWorktreeDialog();
worktreeCloseBtn.onclick = closeWorktreeDialog;
worktreeCancelBtn.onclick = closeWorktreeDialog;
worktreeOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === worktreeOverlay) closeWorktreeDialog();
});
worktreePanel.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    worktreeSubmitBtn.click();
  }
});
worktreeBaseSel.addEventListener("change", updateWorktreeDialog);
worktreeBranchEl.addEventListener("input", updateWorktreeDialog);
worktreePrSel.addEventListener("change", updateWorktreeDialog);
worktreeDirectoryEl.addEventListener("input", updateWorktreeDialog);
for (const radio of worktreeSourceRadios) {
  radio.addEventListener("change", () => {
    applyWorktreeSourceMode();
    updateWorktreeDialog();
    const root = worktreeDialogRoot;
    // PR モードに入った時だけ gh を呼ぶ（開いただけでは呼ばない）
    if (root && worktreeSourceMode() === "pr") void loadWorktreePrs(root);
  });
}
for (const radio of worktreeLocRadios) {
  radio.addEventListener("change", () => {
    // モードごとに前回の格納先を出し分ける（打ち直さなくていいように）
    worktreeDirectoryEl.value = worktreeDirFor(worktreeLocationMode());
    applyWorktreeLocationMode();
    updateWorktreeDialog();
  });
}
worktreeSubmitBtn.onclick = () => {
  const root = worktreeDialogRoot;
  const directory = worktreeDirectoryEl.value.trim();
  const location = worktreeLocationMode();
  const inherit = worktreeInheritMode();
  const source = worktreeSourceMode();
  const pr = source === "pr" ? selectedPr() : null;
  const baseRef = worktreeBaseSel.value;
  const branch = pr ? pr.headRefName : worktreeBranchEl.value.trim();
  if (!root || !directory || !branch) return;
  if (source === "pr" ? !pr : !baseRef) return;
  worktreeErrorEl.hidden = true;
  void (async () => {
    // runGitAction のコールバックから成功結果も受け取る。可変オブジェクトに入れるのは、
    // TypeScript がネストしたコールバック内のローカル変数代入を到達可能と判定しないため。
    const outcome: { created: WorktreeResult | null } = { created: null };
    worktreeProgress.start(root);
    const ok = await runGitAction(
      async () => {
        // PR は「そのブランチを用意する」ので既存ブランチも受け付ける専用コマンド。
        // ブランチ起点の作成は従来どおり新しいブランチを切る
        const result = pr
          ? await invoke<WorktreeResult>("git_worktree_from_pr", {
              root,
              number: pr.number,
              branch,
              directory,
              location,
              inherit,
            })
          : await invoke<WorktreeResult>("git_worktree_create", {
              root,
              baseRef,
              branch,
              directory,
              location,
              inherit,
            });
        updateWorktreePrefs(
          location === "outside"
            ? { location, outsideDir: directory, inherit }
            : { location, insideDir: directory, inherit },
        );
        outcome.created = result;
        return worktreeResultMessage(result);
      },
      (error) => {
        worktreeErrorEl.textContent = error;
        worktreeErrorEl.hidden = false;
      },
    );
    worktreeProgress.stop();
    if (ok && outcome.created) {
      // 先にモーダルを閉じてから作る。closeWorktreeDialog のボタン focus より後に
      // 新しいターミナルを focus させ、そのまま入力できる状態にするため。
      const beforeOpenSession = worktreeBeforeOpenSession;
      closeWorktreeDialog();
      beforeOpenSession?.();
      deps.openSession({
        // PR 由来のセッションは Issue 実行と同じく「#番号 タイトル」で見分けられるようにする
        name: pr ? `#${pr.number} ${pr.title}` : outcome.created.branch,
        cwd: outcome.created.path,
      });
    }
  })();
};

// Escape でモーダルを閉じる。元はプルモーダルと1つの listener を共有し、
// プルが開いていればそちらを優先する else-if だったので、その順序をここで保つ。
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || isPullDialogOpen()) return;
    if (!worktreeOverlay.hidden) {
      // PR 詳細や拡大 Git モーダルの上に重ねて開くので、後ろの Escape 処理まで届かせない
      e.stopImmediatePropagation();
      e.preventDefault();
      closeWorktreeDialog();
    }
  },
  true,
);
