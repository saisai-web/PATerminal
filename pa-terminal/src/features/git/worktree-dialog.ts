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
import { listen } from "@tauri-apps/api/event";
import type { PrList, PrSummary } from "./git-panel-types";
import { getGitRoot } from "./agent-panel";
import { isActionBusy, runGitAction } from "./git-actions";
import { t } from "../../i18n";
import { isPullDialogOpen } from "./pull-dialog";
import {
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
const worktreeProgressEl = document.querySelector<HTMLDivElement>("#worktree-progress")!;
const worktreeProgressTitleEl = document.querySelector<HTMLSpanElement>("#worktree-progress-title")!;
const worktreeProgressDetailEl = document.querySelector<HTMLSpanElement>("#worktree-progress-detail")!;
const worktreeProgressBarEl = worktreeProgressEl.querySelector<HTMLDivElement>(".wt-progress-bar")!;
const worktreeProgressFillEl = document.querySelector<HTMLDivElement>("#worktree-progress-fill")!;
const worktreeProgressCountEl = document.querySelector<HTMLSpanElement>("#worktree-progress-count")!;

type WorktreeSource = "branch" | "pr";

let worktreeDialogRoot: string | null = null;
let worktreeLoading = false;
let worktreeLoadToken = 0;
/** PR モードで選べる open な PR。null は「まだ取っていない」 */
let worktreePrs: PrSummary[] | null = null;
let worktreePrLoading = false;
let worktreePrToken = 0;
/** 作成中（worktree add → 環境ファイルのコピー）。ローディングを出している間だけ true */
let worktreeWorking = false;

type WorktreeInheritProgress = {
  root: string;
  target: string;
  done: number;
  total: number;
  entry: string;
};

/** ローディングの表示。`progress` が無い間は件数不明の流れる帯にする。 */
function showWorktreeProgress(progress: WorktreeInheritProgress | null): void {
  worktreeProgressEl.hidden = false;
  if (!progress) {
    worktreeProgressTitleEl.textContent = t("agent.worktreeProgressCreating");
    worktreeProgressDetailEl.textContent = "";
    worktreeProgressCountEl.textContent = "";
    worktreeProgressBarEl.classList.add("is-indeterminate");
    worktreeProgressFillEl.style.width = "0";
    return;
  }
  const finished = progress.total > 0 && progress.done >= progress.total;
  worktreeProgressTitleEl.textContent = t(
    finished ? "agent.worktreeProgressFinishing" : "agent.worktreeProgressCopying",
  );
  worktreeProgressDetailEl.textContent = progress.entry;
  worktreeProgressCountEl.textContent = progress.total > 0 ? `${progress.done} / ${progress.total}` : "";
  worktreeProgressBarEl.classList.remove("is-indeterminate");
  const ratio = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  worktreeProgressFillEl.style.width = `${Math.round(ratio * 100)}%`;
}

function hideWorktreeProgress(): void {
  worktreeProgressEl.hidden = true;
  worktreeProgressBarEl.classList.add("is-indeterminate");
  worktreeProgressFillEl.style.width = "0";
}

// Rust からの引き継ぎ進捗。root が一致する（= このダイアログが頼んだ）ものだけ表示に反映する
void listen<WorktreeInheritProgress>("worktree:inherit", (e) => {
  if (!worktreeWorking || e.payload.root !== worktreeDialogRoot) return;
  showWorktreeProgress(e.payload);
});

export function isWorktreeDialogOpen(): boolean {
  return !worktreeOverlay.hidden;
}

export function getWorktreeDialogRoot(): string | null {
  return worktreeDialogRoot;
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

async function openWorktreeDialog(): Promise<void> {
  const root = getGitRoot();
  if (!root || isActionBusy()) return;
  worktreeDialogRoot = root;
  worktreeRootEl.textContent = root;
  worktreeBaseSel.innerHTML = "";
  worktreeBranchEl.value = "";
  // PR 一覧はリポジトリごとに取り直す（開くたびに gh は呼ばず、PR モードに入った時だけ）
  worktreePrs = null;
  worktreePrLoading = false;
  ++worktreePrToken;
  for (const radio of worktreeSourceRadios) radio.checked = radio.value === "branch";
  renderWorktreePrOptions();
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
      if (branch.current) worktreeBaseSel.value = branch.reference;
    }
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
      requestAnimationFrame(() => worktreeBranchEl.focus());
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
  worktreeBtn.focus();
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
/** 作成結果の文言。引き継いだ件数を添え、一部失敗があれば警告を続ける。 */
function worktreeResultMessage(result: WorktreeResult): string {
  const path = result.path;
  let message = result.reused
    ? t("agent.worktreeReused", { path })
    : result.inherited > 0
      ? t("agent.worktreeCreatedInherited", { path, count: String(result.inherited) })
      : t("agent.worktreeCreated", { path });
  const warning = result.inheritWarning?.trim();
  if (warning) message += `\n${t("agent.worktreeInheritWarning", { error: warning })}`;
  return message;
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
    worktreeWorking = true;
    showWorktreeProgress(null);
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
    worktreeWorking = false;
    hideWorktreeProgress();
    if (ok && outcome.created) {
      // 先にモーダルを閉じてから作る。closeWorktreeDialog のボタン focus より後に
      // 新しいターミナルを focus させ、そのまま入力できる状態にするため。
      closeWorktreeDialog();
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
      e.stopPropagation();
      closeWorktreeDialog();
    }
  },
  true,
);
