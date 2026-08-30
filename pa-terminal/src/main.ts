import "./platform/dev-mock"; // ブラウザ単体テスト用IPCモック。Tauri実行時は何もしない
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { initAgentWatch } from "./features/agents/watch";
import { initTakeover } from "./features/agents/takeover";
import { initAgentPanel } from "./features/git/agent-panel";
import { initGitPanel } from "./features/git/git-panel";
import { initWsGit } from "./features/sidebar/ws-git";
import { initQuickPhrases } from "./features/quick-phrases/quick-phrases";
import { initImageAttachments } from "./features/attachments/image-attachments";
import { initWorktreePrefs } from "./features/git/worktree";
import { initWorktreeDialog } from "./features/git/worktree-dialog";
import { updateWsActivity } from "./app/activity";
import "./terminal/diag";
import { broadcastWrite, toggleBroadcast } from "./terminal/focus";
import { initBroadcastDialog, openBroadcastDialog } from "./features/broadcast/broadcast-dialog";
import {
  explorerFollow,
  initExplorer,
  isExplorerOpen,
  setExplorerOpen,
} from "./features/explorer/explorer";
import { layout, scheduleLayout } from "./terminal/layout";
import { normPath } from "./features/explorer/paths";
import { boot, restoreDeletedWorkspace, scheduleSave } from "./app/session";
import "./app/shortcuts";
import {
  getActiveWs,
  getFocusedId,
  panes,
  setAppFocused,
  workspaces,
} from "./workspace/state";
import { closePane, firstLeaf, restartPane, splitPane } from "./terminal/tree";
import {
  closeWorkspace,
  createWorkspace,
  createWorkspaceBesideActive,
  newSessionCwd,
  onActiveWorkspaceChange,
  placeAfter,
  setActive,
  workspaceCwd,
} from "./workspace/workspace";
import { setFocused } from "./terminal/focus";
import { groupById, groupPath } from "./workspace/groups";
import { getDeletedWorkspaces } from "./features/sidebar/session-trash";
import { initSessionTrash } from "./features/sidebar/session-trash";
import { initHistoryDialog } from "./features/history/history-dialog";
import { initPairMode, nextPairSessionName, updatePairStrip } from "./features/pair/pair";
import { renderAutoEnterButton } from "./features/settings/settings-panel";
import { initLicense, onLicenseChange, requireFeature } from "./features/license/license";
import { renderLockMarks } from "./features/license/lock-marks";
import { initPurchaseModal } from "./features/license/purchase-modal";
import { initLicenseBanner } from "./features/license/banner";
import { initGuide } from "./features/license/guide";
import { initLicenseSettings, setLicenseManageOpen } from "./features/license/license-settings";
import { initSelfBuildNotify } from "./features/license/self-build-notify";
import { ensureEulaAccepted } from "./features/license/eula";
import { stopBroadcast } from "./terminal/focus";
import { stopPairAutoRelay } from "./features/pair/pair";

// ============================================================
// 状態
// ============================================================

const broadcastBtn = document.querySelector<HTMLButtonElement>("#broadcast")!;
const bcHintEl = document.querySelector<HTMLSpanElement>("#bc-hint")!;
const splitRightBtn = document.querySelector<HTMLButtonElement>("#split-right")!;
const splitDownBtn = document.querySelector<HTMLButtonElement>("#split-down")!;

// 通知ゲート用のフォーカス追跡（メニュー閉じ処理とは独立に持つ）
window.addEventListener("focus", () => {
  setAppFocused(true);
  const ws = getActiveWs();
  if (ws) {
    ws.attention = null; // 復帰して見ているセッションの注意は既読
    updateWsActivity(ws);
  }
});
window.addEventListener("blur", () => {
  setAppFocused(false);
});

// ============================================================
// 配線
// ============================================================

splitRightBtn.onclick = () => {
  const ws = getActiveWs();
  const fid = getFocusedId();
  if (ws && fid) splitPane(ws, fid, "row");
};
splitDownBtn.onclick = () => {
  const ws = getActiveWs();
  const fid = getFocusedId();
  if (ws && fid) splitPane(ws, fid, "col");
};
// 一斉入力 OFF のときは送信先モーダルを開く。ON のときはボタンで即停止（従来のトグル）。
// ロックのゲートは開始側だけ: 「もう一度押せば必ず止まる」は Locked でも壊さない
broadcastBtn.onclick = () => {
  if (getActiveWs()?.broadcast) toggleBroadcast();
  else if (requireFeature()) openBroadcastDialog();
};
initBroadcastDialog({
  focusTerminal: () => {
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (ws && fid) ws.panes.get(fid)?.focus();
  },
});
initImageAttachments();
initQuickPhrases({
  // 定型文はクリックでも選択モードの Enter でも入力のみ。実行用の改行は送らない。
  insert: (text) => {
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (!ws || !fid) return false;
    const pane = ws.panes.get(fid);
    if (!pane) return false;
    if (ws.broadcast) broadcastWrite(ws, text);
    else pane.write(text);
    pane.focus();
    return true;
  },
  onChange: scheduleSave,
  layout: () => layout(),
  focusTerminal: () => {
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (!ws || !fid) return;
    ws.panes.get(fid)?.focus();
  },
});
initWorktreePrefs({ onChange: scheduleSave });
initWorktreeDialog({
  openSession: ({ name, cwd }) => {
    const current = getActiveWs();
    const ws = createWorkspace(name, "default", { cwd, group: current?.group });
    if (current) placeAfter(ws, current);
  },
});
const sessionTrashTab = initSessionTrash({
  restore: restoreDeletedWorkspace,
  onChange: scheduleSave,
  clearPane: () => {
    const ws = getActiveWs();
    if (!ws) return;
    const fid = getFocusedId();
    const pane = (fid ? ws.panes.get(fid) : undefined) ?? firstLeaf(ws.root)?.pane;
    if (pane) void restartPane(ws, pane.id);
  },
});
initPairMode({
  layout: () => layout(),
  focusTerminal: () => {
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (ws && fid) ws.panes.get(fid)?.focus();
  },
  // 新しいペアセッション: 表示中ペインの cwd で左右2ペインのセッションを開き、
  // それぞれの起動コマンドを流し込む（spec.run = 復元時の再開コマンドと同じ経路）
  createPairSession: async ({ implCmd, reviewCmd, cwd: requestedCwd }) => {
    const cwd = requestedCwd || (await newSessionCwd());
    const ws = createWorkspaceBesideActive(nextPairSessionName(), "default", {
      cwd,
      pane: { title: "impl", run: implCmd },
    });
    try {
      const impl = firstLeaf(ws.root)!.pane;
      splitPane(ws, impl.id, "row", { title: "review", cwd, run: reviewCmd });
      const review = [...ws.panes.values()].find((p) => p !== impl)!;
      // splitPane はレビュー役へ setFocused するので、実装役へ入力カーソルを戻す
      setFocused(impl.id);
      return [impl, review];
    } catch (error) {
      await closeWorkspace(ws);
      throw error;
    }
  },
  // あとづけレビュー: 実装役（フォーカス中）ペインの隣にレビュー役ペインを分割で作る。
  // cwd は実装役のシェルの実 cwd（pty_cwd → OSC 7 / spec.cwd）を引き継ぐ
  addReviewerPane: async ({ impl, cmd }) => {
    const ws = impl.ws;
    let live: string | null = null;
    if (impl.alive) {
      try {
        live = await invoke<string | null>("pty_cwd", { id: impl.id });
      } catch {
        /* フォールバックへ */
      }
    }
    const cwd = live ?? impl.cwd ?? impl.spec.cwd ?? undefined;
    // await 中にセッション / ペインが閉じられていたら中断
    if (!workspaces.includes(ws) || !ws.panes.has(impl.id)) return null;
    splitPane(ws, impl.id, "row", { title: "review", cwd, run: cmd });
    const review = ws.panes.get(getFocusedId()!) ?? null;
    // splitPane はレビュー役へ setFocused するので、実装役へ入力カーソルを戻す
    setFocused(impl.id);
    return review;
  },
  getFocusedPane: () => {
    const ws = getActiveWs();
    const fid = getFocusedId();
    return ws && fid ? (ws.panes.get(fid) ?? null) : null;
  },
  // 表示中セッションの中身をペアの2ペインへ置き換える（セッション名・位置・グループは維持）。
  // duplicateWorkspace と同じく、cwd 解決の await 中にセッションが閉じられたら中断する
  replacePanesWithPair: async ({ implCmd, reviewCmd }) => {
    const ws = getActiveWs();
    if (!ws || !ws.root) return null;
    const oldIds = [...ws.panes.keys()];
    const cwd = await newSessionCwd();
    if (!workspaces.includes(ws) || !ws.root) return null;
    const fid = getFocusedId();
    const base = fid && ws.panes.has(fid) ? fid : firstLeaf(ws.root)!.pane.id;
    // splitPane は新しいペインへ setFocused するので、直後の focusedId が新ペイン
    splitPane(ws, base, "row", { title: "impl", cwd, run: implCmd });
    const impl = ws.panes.get(getFocusedId()!)!;
    splitPane(ws, impl.id, "row", { title: "review", cwd, run: reviewCmd });
    const review = ws.panes.get(getFocusedId()!)!;
    // 新しい2ペインができてから元のペインを閉じる（「最後の1枚」ガードに掛からない）
    for (const id of oldIds) await closePane(ws, id);
    // splitPane はレビュー役へ setFocused するので、実装役へ入力カーソルを戻す
    setFocused(impl.id);
    return [impl, review];
  },
});
// セッション切替でペアストリップとツールバーの ⇄ ボタンを追従させる
onActiveWorkspaceChange(() => updatePairStrip());
onActiveWorkspaceChange(() => renderAutoEnterButton());
// 分割ボタンの 🔒 はアクティブセッションのペイン数に依存する（2枚まで無料）
onActiveWorkspaceChange(() => renderLockMarks());

// ---- ライセンス / ソフトロック ----
initPurchaseModal({
  focusTerminal: () => {
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (ws && fid) ws.panes.get(fid)?.focus();
  },
  openLicense: () => setLicenseManageOpen(true),
});
initLicenseSettings();
onLicenseChange((s) => {
  if (s.locked) {
    // 稼働中の自動送信系だけ止める。ペイン・プロセス・表示は殺さない（作業を破壊しない）
    for (const w of workspaces) if (w.broadcast) stopBroadcast(w);
    stopPairAutoRelay();
  }
  renderLockMarks();
});

// ---- 変更ストリップ（ターミナル上部の git 自動表示） ----

/** 変更ストリップが監視すべき cwd。フォーカス中ペインのシェルの実 cwd（pty_cwd）を
    優先し、取れない環境（プロセス終了直後・旧バイナリ）は OSC 7 / spec.cwd に
    フォールバックする。OSC 7 はシェル統合が無いと飛ばず cd に追従できないため
    （Windows の PowerShell だけは PEB から cwd を読めないので、pty_spawn 側が
    OSC 7 を吐くプロンプトを注入して同じ追従にしている） */
async function resolveWatchCwd(): Promise<string | null> {
  const fid = getFocusedId();
  const pane = fid ? panes.get(fid) : undefined;
  if (!pane) return null;
  let live: string | null = null;
  if (pane.alive) {
    try {
      live = await invoke<string | null>("pty_cwd", { id: pane.id });
    } catch {
      /* フォールバックへ */
    }
  }
  const p = live ?? pane.cwd ?? pane.spec.cwd;
  if (!p) return null;
  const n = normPath(p);
  // エクスプローラーの追従もここに相乗り: OSC 7 が飛ばないシェルでも
  // 3秒ポーリング + フォーカス移動契機で cd に追従できる。
  // await 中にフォーカスが移った場合の古い cwd は反映しない
  if (pane.id === getFocusedId()) explorerFollow(n);
  return n;
}

initExplorer({ createWorkspace: createWorkspaceBesideActive });
initAgentPanel({ layout: () => layout(), resolveWatchCwd, onCollapseChange: scheduleSave });
initGitPanel({
  isExplorerOpen,
  createIssueSession: ({ issueNumber, issueTitle, cwd }) => {
    const name = `#${issueNumber} ${issueTitle}`;
    createWorkspaceBesideActive(name, "default", { cwd });
  },
});

// ---- サイドバーのセッション git バッジ（全セッションを直列ポーリング） ----
initWsGit({
  getTargets: () =>
    workspaces.map((w) => {
      const fid = getFocusedId();
      return {
        wsId: w.id,
        // 同じセッションの別ペインが worktree で作業し始めたときも
        // バッジが追従できるよう、開いている全ペインを候補にする。
        panes: [...w.panes.values()].map((pane) => {
          const fallback = pane.cwd ?? pane.spec.cwd;
          return {
            paneId: pane.id,
            paneAlive: pane.alive,
            fallbackCwd: fallback ? normPath(fallback) : null,
            busy: pane.busy,
            focused: pane.id === fid,
          };
        }),
      };
    }),
});

// ---- 実行中エージェントの検知（復元時の会話再開 + 終了バナー） ----
initAgentWatch();

// ---- 履歴の引き継ぎ（実行中の会話一覧 + 保存済み会話のピッカー） ----
const takeoverTab = initTakeover({
  openSession: ({ name, cwd, run }) =>
    createWorkspaceBesideActive(name, "default", { cwd, pane: { run } }),
  showPane: (ws, paneId) => {
    setActive(ws);
    setFocused(paneId);
  },
  groupPathOf: (groupId) => {
    const group = groupById(groupId);
    return group ? groupPath(group) : null;
  },
  deletedWorkspaces: getDeletedWorkspaces,
});
initHistoryDialog({
  takeover: takeoverTab,
  trash: sessionTrashTab,
  focusTerminal: () => {
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (ws && fid) ws.panes.get(fid)?.focus();
  },
});

// ドラッグ中は矩形だけ追従し、止まってから1回だけ refit する（TUI へ SIGWINCH を連射しない）
window.addEventListener("resize", () => scheduleLayout());

// エクスプローラーは起動時デフォルト表示（× で閉じ、Files ボタン / Cmd+E で開き直す）
async function startApp(): Promise<void> {
  if (!(await ensureEulaAccepted())) return;
  await boot();
  setExplorerOpen(true, { save: false });
  // ライセンス状態は boot() 内で確定済み。バナー・初回ガイド・1時間ごとの再評価・
  // 自ビルドの新バージョン通知はその後に起動する
  initLicenseBanner({ layout: () => layout() });
  initGuide();
  initLicense();
  initSelfBuildNotify();
}

void startApp();
