import { isExplorerOpen, setExplorerOpen } from "../features/explorer/explorer";
import { toggleBroadcast } from "../terminal/focus";
import { startQuickPhraseSelection } from "../features/quick-phrases/quick-phrases";
import {
  isSidebarOpen,
  openNewSessionForm,
  setSidebarOpen,
  stepActiveWorkspace,
} from "../features/sidebar/sidebar";
import { getActiveWs, getFocusedId, getHostOs, workspaces } from "../workspace/state";
import { closePane, splitPane } from "../terminal/tree";
import { setActive } from "../workspace/workspace";

const gridEl = document.querySelector<HTMLDivElement>("#grid")!;

/** 前後のセッションへ移動するキーか。移動したら true。
    - Ctrl+Tab / Ctrl+Shift+Tab: 端末に対応するエスケープが無いので全 OS で奪ってよい
      （macOS の Cmd+Tab は OS のアプリ切替なのでそもそもここへ来ない）
    - Cmd(+Ctrl)+Shift+↑↓: サイドバーの並びに合わせた上下版。macOS の Ctrl+Shift+↑↓ は
      TUI が使う CSI 1;6A/B なので奪わない（⌘⇧↑↓ のみ） */
function handleSessionSwitch(e: KeyboardEvent): boolean {
  if (!e.metaKey && !e.ctrlKey) return false;
  if (e.code === "Tab" && e.ctrlKey) {
    stepActiveWorkspace(e.shiftKey ? -1 : 1);
    return true;
  }
  if (
    e.shiftKey &&
    (e.code === "ArrowUp" || e.code === "ArrowDown") &&
    (getHostOs() !== "macos" || e.metaKey)
  ) {
    stepActiveWorkspace(e.code === "ArrowDown" ? 1 : -1);
    return true;
  }
  return false;
}

// ターミナル領域だけは capture で先取りする。xterm は自分が解釈するキー（Tab・矢印）を
// textarea の keydown で preventDefault + stopPropagation（内部の cancel()）してしまうため、
// 下の window リスナー（bubble）には届かず「ターミナルにカーソルがあると切り替えられない」
// ことになる。capture 対象を #grid に限れば、モーダルやインライン編集が
// ショートカット暴発防止のために張っている stopPropagation には影響しない。
gridEl.addEventListener(
  "keydown",
  (e) => {
    // ペイン名のインライン編集中は編集を優先する（#grid の中にある唯一の入力欄）
    if (e.target instanceof HTMLInputElement) return;
    if (!handleSessionSwitch(e)) return;
    e.preventDefault();
    e.stopPropagation(); // xterm へ \t / CSI を渡さない。window の bubble も止まる
  },
  true,
);

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  // ターミナル以外（サイドバーの検索欄など）にフォーカスがあるときの前後移動。
  // ターミナル上での打鍵は上の capture 側が処理して stopPropagation するのでここには来ない
  if (handleSessionSwitch(e)) {
    e.preventDefault();
    return;
  }
  if (!e.shiftKey) {
    // Shift なしの Cmd/Ctrl+T / Cmd/Ctrl+E / Cmd/Ctrl+数字はシェルに流さず奪う
    if (e.code === "KeyT") {
      e.preventDefault();
      openNewSessionForm();
      return;
    }
    // エクスプローラー開閉。macOS の Ctrl+E は readline の行末移動なので奪わない（⌘E のみ）
    if (e.code === "KeyE" && (getHostOs() !== "macos" || e.metaKey)) {
      e.preventDefault();
      setExplorerOpen(!isExplorerOpen());
      return;
    }
    // サイドバー開閉。macOS の Ctrl+B は readline の1文字戻りなので奪わない（⌘B のみ）
    if (e.code === "KeyB" && (getHostOs() !== "macos" || e.metaKey)) {
      e.preventDefault();
      setSidebarOpen(!isSidebarOpen());
      return;
    }
    // 定型文のキーボード選択。macOS の Ctrl+P は readline の履歴前候補なので奪わない（⌘P のみ）
    if (e.code === "KeyP" && (getHostOs() !== "macos" || e.metaKey)) {
      e.preventDefault();
      startQuickPhraseSelection();
      return;
    }
    const n = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (n) {
      e.preventDefault();
      const ws = workspaces[Number(n) - 1];
      if (ws) setActive(ws);
    }
    return;
  }
  // 注意: Ctrl+D 単体は EOF なので絶対に奪わない。Shift 併用のみ。
  if (e.code === "KeyD") {
    e.preventDefault();
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (ws && fid) splitPane(ws, fid, "row");
  } else if (e.code === "KeyS") {
    e.preventDefault();
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (ws && fid) splitPane(ws, fid, "col");
  } else if (e.code === "KeyW") {
    e.preventDefault();
    const ws = getActiveWs();
    const fid = getFocusedId();
    if (ws && fid) void closePane(ws, fid);
  } else if (e.code === "KeyB") {
    e.preventDefault();
    toggleBroadcast();
  }
});
