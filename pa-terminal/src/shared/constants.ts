// ============================================================
// 定数
// ============================================================

import { t } from "../i18n";
import type { PaneSpec, ShellKind } from "../workspace/types";

export const DIVIDER = 6; // px。styles.css の --divider と一致させること
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;
export const SNAPSHOT_LINES = 2000; // セッションに保存するスクロールバック行数の上限
// これを下回るサイズでは fit しない。FitAddon は要素が DOM に付いていて 0px のとき
// undefined ではなく 2x1 を返すので、そのまま fit するとバッファが2桁に折り返され、
// 元のサイズに戻しても直らない（最小化・最大化・スナップの一瞬に起きる）。
// **MIN_RATIO まで詰めた正当な狭いペインは 8 桁程度まで下がる**ので、
// 弾きたい退化値（2x1）だけを落とせる低さに留めること。
export const MIN_FIT_COLS = 4;
export const MIN_FIT_ROWS = 2;

// 初回起動のデフォルトセッション構築にのみ使用
export const PRESETS: Record<string, PaneSpec[]> = {
  "shell x1": [{ title: "shell" }],
  "shell x4": [{ title: "1" }, { title: "2" }, { title: "3" }, { title: "4" }],
  "agents x3": [
    // resumeRun: 復元時は前回の会話を引き継いで再開する
    { title: "claude", run: "claude", resumeRun: "claude --continue" },
    { title: "codex", run: "codex", resumeRun: "codex resume --last" },
    { title: "shell" },
  ],
};

export const AVATAR_COLORS = ["#c9a7f5", "#8cc265", "#61afef", "#d9c07c", "#56b6c2", "#e06c75"];

// label は描画時に解決する（固定文字列は固有名詞なのでそのまま、default だけ翻訳）
export const SHELL_CHOICES: Array<{ kind: ShellKind; label: () => string; os?: string[] }> = [
  // Windows の default は powershell.exe なので、明示的な PowerShell と重複させない。
  { kind: "default", label: () => t("shell.default"), os: ["macos", "linux"] },
  { kind: "powershell", label: () => "PowerShell" },
  { kind: "cmd", label: () => "Command Prompt", os: ["windows"] }, // Windows のみ表示
];
