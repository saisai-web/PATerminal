// 変更ストリップ（#agent-panel）: 「作業の見える化」専用。Git リポジトリ内では
// 変更ファイルが 0 件でも常時表示し、リポジトリ外へ移動したときだけ隠す。
// ターミナルの上側（ツールバー直下）の横帯で、右パネルのようにターミナル幅を奪わない。
//
// フォーカス中ペインの cwd 配下の git 変更を定期ポーリング（git_changes）し、
// 変更ファイルを「ファイル名 +N -M」のチップで横並び表示。
// チップクリックで git_file_diff → diff オーバーレイ（LCS 行 diff）。
// ターミナルで claude / codex を普通に動かすだけで、上に変更が出るのが狙い。
//
// 色は必ず CSS 変数経由（テーマ切替から漏れるため hex ハードコード禁止）。
//
// 操作バーと3つのモーダルは別ファイル（git-actions / commit-dialog / pull-dialog /
// worktree-dialog）。git 監視の結果はこのファイルが所有し、accessor 経由で読ませる。

import { invoke } from "@tauri-apps/api/core";
import {
  closeCommitDialog,
  getCommitDialogCwd,
  isCommitDialogOpen,
  renderCommitFiles,
} from "./commit-dialog";
import { openFileDiffOverlay, openWorktreeDiffOverlay } from "./diff-overlay";
import type { CommitDiff } from "./diff-overlay";
import {
  renderBranches,
  setGitActionsVisible,
  showGitMsg,
  updateCommitButton,
  updateStashButton,
  updateWorktreeButton,
} from "./git-actions";
import type { GitBranches } from "./git-actions";
import { gitPanelTick } from "./git-panel";
import { t } from "../../i18n";
import { isLocked } from "../license/license";
import { closePullDialog, getPullDialogRoot, isPullDialogOpen } from "./pull-dialog";
import { setQuickPhraseRepo } from "../quick-phrases/quick-phrases";
import {
  isWorktreeDialogOpen,
  renderWorktreeDialogTexts,
  syncWorktreeDialogWithStrip,
} from "./worktree-dialog";
import { trackSelectionDrag } from "../../shared/selection-drag";

type PanelDeps = {
  /** ストリップ開閉時の再レイアウト（グリッドの高さが変わり、refit で TUI に resize が飛ぶ） */
  layout: () => void;
  /** 監視すべき cwd（フォーカス中ペインのシェルの実 cwd）。ポーリングごとに解決する */
  resolveWatchCwd: () => Promise<string | null>;
  /** 1行表示の状態が変わったときの保存（勝手に全展開しないため session.json に残す） */
  onCollapseChange: () => void;
};

let deps: PanelDeps = {
  layout: () => {},
  resolveWatchCwd: async () => null,
  onCollapseChange: () => {},
};

const panelEl = document.querySelector<HTMLDivElement>("#agent-panel")!;
const headEl = document.querySelector<HTMLDivElement>("#agent-head")!;
const collapseBtn = document.querySelector<HTMLButtonElement>("#agent-collapse")!;
const contentEl = document.querySelector<HTMLDivElement>("#agent-content")!;
const titleLabelEl = document.querySelector<HTMLSpanElement>("#agent-title-label")!;
const summaryEl = document.querySelector<HTMLSpanElement>("#agent-summary")!;
const viewAllBtn = document.querySelector<HTMLButtonElement>("#agent-title")!;
const emptyEl = document.querySelector<HTMLDivElement>("#agent-empty")!;
const gitWrap = document.querySelector<HTMLDivElement>("#git-changes")!;
const gitList = document.querySelector<HTMLDivElement>("#git-changes-list")!;

let panelOpen = false;
// 1行表示では変更一覧と操作バーを横スクロール可能な1列にする。
// 状態は session.json に保存する: 「一度たたんだら自分で開くまで全展開しない」ので、
// 変更ファイルが増えても・リポジトリを移っても・再起動しても勝手に開き直さない。
let panelCollapsed = true;

export function initAgentPanel(d: PanelDeps): void {
  deps = d;
}

function setAgentPanelOpen(open: boolean): boolean {
  if (panelOpen === open) return false;
  panelOpen = open;
  panelEl.hidden = !open;
  return true;
}

function applyCollapsed(): void {
  // content は隠さず、CSS で変更チップを1行に切り詰める。hidden は旧状態からの復元対策で外す。
  contentEl.hidden = false;
  panelEl.classList.toggle("is-collapsed", panelCollapsed);
  collapseBtn.textContent = panelCollapsed ? "▸" : "▾";
  collapseBtn.setAttribute("aria-expanded", String(!panelCollapsed));
  collapseBtn.title = t(panelCollapsed ? "agent.expand" : "agent.collapse");
  renderCollapsedSummary();
}

function setPanelCollapsed(collapsed: boolean): void {
  if (panelCollapsed === collapsed) return;
  panelCollapsed = collapsed;
  applyCollapsed();
  deps.onCollapseChange(); // 次の起動でも同じ状態で開く
  deps.layout(); // 帯の高さが変わる（開閉と同じ理由で refit 必須）
}

/** 起動時の復元用（保存も再レイアウトもせず状態だけ合わせる） */
export function setAgentPanelCollapsed(collapsed: boolean): void {
  panelCollapsed = collapsed;
  applyCollapsed();
}

export function isAgentPanelCollapsed(): boolean {
  return panelCollapsed;
}

/** 全変更一覧ボタンに「N件 +追加 -削除」を出す。1行表示では個別ファイルを隠すため唯一の一覧入口になる。 */
function renderCollapsedSummary(): void {
  summaryEl.hidden = gitCount === 0;
  titleLabelEl.hidden = gitCount > 0;
  summaryEl.innerHTML = "";
  if (summaryEl.hidden) return;
  const label = document.createElement("span");
  label.textContent = "ChangeFile";
  const count = document.createElement("span");
  count.textContent = String(gitCount);
  const adds = document.createElement("span");
  adds.className = "agent-file-adds";
  adds.textContent = `+${gitFiles.reduce((n, f) => n + f.adds, 0)}`;
  const dels = document.createElement("span");
  dels.className = "agent-file-dels";
  dels.textContent = `-${gitFiles.reduce((n, f) => n + f.dels, 0)}`;
  const stats = document.createElement("span");
  stats.className = "agent-summary-stats";
  stats.append(count, adds, dels);
  summaryEl.append(label, stats);
}

collapseBtn.onclick = () => setPanelCollapsed(!panelCollapsed);
// 見出しのボタン操作をターミナルやグローバルショートカットに流さない（操作バーと同じ流儀）
headEl.addEventListener("keydown", (e) => e.stopPropagation());

// 三角ボタン以外に帯の非操作領域全体でも開閉する。展開中は変更一覧と操作バーが帯の大半を
// 占めるので、コンテナの直接一致だけに限ると閉じられる場所がほとんど残らない。
// 実際の操作部品・変更ファイル行・結果表示だけを除外する。
const collapseExclusions = "button, select, input, textarea, a, .agent-file-row, #git-msg";
const consumeSelectionDrag = trackSelectionDrag(panelEl);
panelEl.addEventListener("click", (e) => {
  const selectedByThisDrag = consumeSelectionDrag();
  const target = e.target;
  if (!(target instanceof Element) || target.closest(collapseExclusions)) return;
  if (selectedByThisDrag) return; // 今回のドラッグで文字を選んだ直後だけはたたまない
  setPanelCollapsed(!panelCollapsed);
});

/** 言語切替時: 静的部分は data-i18n が処理する。空表示の文言だけ貼り直す */
export function renderAgentPanelTexts(): void {
  emptyEl.textContent = t("agent.empty");
  applyCollapsed(); // たたむボタンの title と件数表示は t() 経由
  // 格納先ラベルはモードで変わるので data-i18n では貼れない
  if (isWorktreeDialogOpen()) renderWorktreeDialogTexts();
}

// ============================================================
// git 変更の自動表示
// 3秒ごと（+ フォーカス移動等の updateGitWatch 契機）にポーリング。監視先の cwd は
// 毎回 resolveWatchCwd で解決する（シェルの実 cwd。cd に確実に追従する）
// ============================================================

export type GitFile = { path: string; adds: number; dels: number; status: string };
type GitChanges = { repo: boolean; root: string | null; files: GitFile[] };

let gitRoot: string | null = null;
let gitCwd: string | null = null; // 直近に監視した cwd（コミット・スタッシュのスコープに使う）
let gitSig = ""; // 前回描画した一覧のシグネチャ（無駄な再描画を避ける）
let gitCount = 0;
let gitFiles: GitFile[] = [];
// 現在ブランチも監視結果の一部（設定は git-actions.ts の renderBranches）
let currentBranch: string | null = null;
let gitBusy = false;
// フォーカス移動や cwd 変更がポーリング中に来ても、その再確認を捨てない。
// true になった時点で進行中の応答は古い監視先のものなので描画せず、直後に取り直す。
let gitPollPending = false;
let worktreeDiffBusy = false;

// 監視結果の accessor（操作バー・モーダルはこれ経由で読む。
// 循環 import の TDZ を避けるため、トップレベルの変数を直接見せない）
export function getGitRoot(): string | null {
  return gitRoot;
}

export function getGitCwd(): string | null {
  return gitCwd;
}

export function getGitFiles(): GitFile[] {
  return gitFiles;
}

export function getGitCount(): number {
  return gitCount;
}

export function getCurrentBranch(): string | null {
  return currentBranch;
}

export function setCurrentBranch(branch: string | null): void {
  currentBranch = branch;
}

/** フォーカス移動や cwd 変化の契機で呼ぶ（定期ポーリングを待たず即1回確認する） */
export function updateGitWatch(): void {
  void pollGit(true);
}

async function pollGit(refreshIfBusy: boolean): Promise<void> {
  // ソフトロック対象（変更ストリップは表示自体もロック）。interval は止めず
  // 毎 tick 冒頭で判定する（購入・キー登録すれば次の tick から自然に復帰する）
  if (isLocked()) {
    if (setAgentPanelOpen(false)) deps.layout();
    return;
  }
  if (gitBusy) {
    // フォーカス移動・cwd 変更などの明示更新だけを予約する。3秒タイマーまで予約すると、
    // 大きなリポジトリで取得に3秒以上かかる場合に応答を捨て続けてしまう。
    if (refreshIfBusy) gitPollPending = true;
    return;
  }
  gitPollPending = true;
  gitBusy = true;
  try {
    while (gitPollPending) {
      gitPollPending = false;
      const cwd = await deps.resolveWatchCwd();
      if (gitPollPending) continue; // await 中に監視先が変わった

      let res: GitChanges | null = null;
      let br: GitBranches | null = null;
      if (cwd) {
        res = await invoke<GitChanges>("git_changes", { cwd }).catch(() => null);
        if (gitPollPending) continue;
        // ブランチ情報もポーリングに相乗り（for-each-ref はローカル処理で軽い）
        if (res?.repo && res.root) {
          br = await invoke<GitBranches>("git_branches", { root: res.root }).catch(() => null);
          if (gitPollPending) continue;
        }
      }

      // cwd・変更一覧・ブランチを同じ監視時点のスナップショットとしてまとめて反映する。
      // エクスプローラー下部の git セクション（コミット履歴 + PR）も同じ cwd で更新する。
      gitPanelTick(cwd);
      gitCwd = res?.repo && cwd ? cwd : null;
      renderGitChanges(res);
      renderBranches(br);
    }
  } finally {
    gitBusy = false;
  }
}

function renderGitChanges(res: GitChanges | null): void {
  const beforeHeight = panelEl.getBoundingClientRect().height;
  const files = res?.repo ? res.files : [];
  const nextRoot = res?.root ?? null;
  gitRoot = nextRoot;
  // 定型文バーは「汎用 + いま見ているリポジトリ専用」だけを出す
  setQuickPhraseRepo(nextRoot);
  gitFiles = files;
  gitCount = files.length;
  // Git 配下ではクリーンな状態でも操作バーを固定表示する。
  const visibilityChanged = setAgentPanelOpen(Boolean(res?.repo));
  viewAllBtn.disabled = worktreeDiffBusy || files.length === 0;
  setGitActionsVisible(Boolean(res?.repo));
  updateWorktreeButton();
  updateStashButton();
  updateCommitButton();
  renderCollapsedSummary();
  if (isCommitDialogOpen() && gitCwd !== getCommitDialogCwd()) closeCommitDialog();
  if (isPullDialogOpen() && nextRoot !== getPullDialogRoot()) closePullDialog();
  syncWorktreeDialogWithStrip(nextRoot);
  const sig = JSON.stringify(files);
  if (sig === gitSig) {
    if (visibilityChanged) deps.layout();
    return;
  }
  gitSig = sig;
  gitWrap.hidden = files.length === 0;
  emptyEl.hidden = gitCount > 0;
  gitList.innerHTML = "";
  for (const f of files) {
    gitList.append(buildFileRow(f.path, f.adds, f.dels, () => void openGitFileDiff(f)));
  }
  if (isCommitDialogOpen()) renderCommitFiles(true);
  // 全展開中は件数によって帯の高さが変わる。1行表示は高さが固定なので再レイアウト不要。
  const heightChanged = Math.abs(panelEl.getBoundingClientRect().height - beforeHeight) > 0.5;
  if (visibilityChanged || (!panelCollapsed && panelOpen && heightChanged)) deps.layout();
}

async function openGitFileDiff(f: GitFile): Promise<void> {
  if (!gitRoot) return;
  const d = await invoke<{ oldText: string; newText: string }>("git_file_diff", {
    root: gitRoot,
    path: f.path,
  }).catch(() => null);
  if (!d) return;
  openFileDiffOverlay({ path: f.path, oldText: d.oldText, newText: d.newText }, f.adds, f.dels);
}

/** 見出しクリック: 作業ツリーの全変更をコミット差分と同じ一覧 UI で開く。 */
async function openGitWorktreeDiff(): Promise<void> {
  const cwd = gitCwd;
  if (!cwd || gitCount === 0 || worktreeDiffBusy) return;
  worktreeDiffBusy = true;
  viewAllBtn.disabled = true;
  try {
    const d = await invoke<CommitDiff>("git_worktree_diff", { cwd });
    // 取得中にフォーカス中ペインの cwd が変わったら古い差分は開かない。
    if (gitCwd === cwd) openWorktreeDiffOverlay(d);
  } catch (e) {
    showGitMsg(String(e), "err");
  } finally {
    worktreeDiffBusy = false;
    viewAllBtn.disabled = gitCount === 0;
  }
}

viewAllBtn.onclick = () => void openGitWorktreeDiff();

window.setInterval(() => void pollGit(false), 3000);

// ============================================================
// ファイル行と diff 描画
// ============================================================

function pathBase(p: string): string {
  const c = p.replace(/\/+$/, "");
  return c.slice(c.lastIndexOf("/") + 1) || p;
}

function pathDir(p: string): string {
  const c = p.replace(/\/+$/, "");
  const i = c.lastIndexOf("/");
  return i > 0 ? c.slice(0, i) : "";
}

/** 「ファイル名 + 追加/削除行数」の1行。クリックで diff オーバーレイを開く */
function buildFileRow(path: string, adds: number, dels: number, onClick: () => void): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "agent-file-row";
  row.title = t("agent.viewDiff", { path });
  const name = document.createElement("span");
  name.className = "agent-file-name";
  name.textContent = pathBase(path);
  const dir = document.createElement("span");
  dir.className = "agent-file-dir";
  dir.textContent = pathDir(path);
  const plus = document.createElement("span");
  plus.className = "agent-file-adds";
  plus.textContent = `+${adds}`;
  const minus = document.createElement("span");
  minus.className = "agent-file-dels";
  minus.textContent = `-${dels}`;
  row.append(name, dir, plus, minus);
  row.onclick = onClick;
  return row;
}
