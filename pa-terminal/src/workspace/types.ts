// ============================================================
// 型
// ============================================================

import type { Pane } from "../terminal/pane";
import type { TreeNode } from "../terminal/tree";

/** ペインで検知した実行中の AI エージェント（claude / codex）。
    保存しておき、復元時に会話を引き継ぐ再開コマンドを組み立てる
    （`src/features/agents/agents.ts` の resumeCommandFor）。 */
export type PaneAgentInfo = {
  kind: string;
  /** エージェント CLI の保存ファイルから解決した会話 ID。無ければ
      `--continue` / `resume --last` 相当の「最後の会話」再開に退化する */
  sessionId?: string;
};

export type PaneSpec = {
  title?: string;
  shell?: string;
  args?: string[];
  /** 直接起動したプロセスを復元するときだけ使う実行ファイルと引数。 */
  resumeShell?: string;
  resumeArgs?: string[];
  cwd?: string;
  /** 初回起動時に流し込むコマンド。末尾の改行は自動付与。 */
  run?: string;
  /** セッション復元時に run の代わりに流し込むコマンド。例: "claude --continue" */
  resumeRun?: string;
  /** 実行中に検知した AI エージェント。復元時の自動再開に使う（検知は features/agents） */
  agent?: PaneAgentInfo;
};

export type Rect = { x: number; y: number; w: number; h: number };

export type SerializedNode =
  | ({ kind: "leaf" } & PaneSpec & { scrollback?: string })
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: SerializedNode; b: SerializedNode };

export type ShellKind = "default" | "powershell" | "cmd";
export type ActivityState = "running" | "waiting" | "done";

/** セッション項目に付けられるテーマ対応の背景色。保存値にもこのIDだけを使う。 */
export const WORKSPACE_BACKGROUND_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;
export type WorkspaceBackgroundColor = (typeof WORKSPACE_BACKGROUND_COLORS)[number];

/** session.json の手編集や将来の値を安全に無色へ退避する。 */
export function normalizeWorkspaceBackgroundColor(
  value: unknown,
): WorkspaceBackgroundColor | undefined {
  return WORKSPACE_BACKGROUND_COLORS.includes(value as WorkspaceBackgroundColor)
    ? (value as WorkspaceBackgroundColor)
    : undefined;
}

export type WorkspaceGroup = {
  id: string;
  name: string;
  /** 未指定ならトップレベル。グループはセッションと独立して空でも保持する */
  parentId?: string;
  /** 同じ親階層でのサイドバー表示順。未指定の旧データは従来順へフォールバックする */
  sidebarOrder?: number;
};

export type Workspace = {
  id: string;
  name: string;
  /** サイドバーと先頭ペインのバーに表示するセッション固有のメモ */
  note?: string;
  /** サイドバーの同じ階層内で先頭に固定する */
  pinned?: boolean;
  /** 通常の一覧から退避し、アーカイブフィルターだけに表示する */
  archived?: boolean;
  /** アーカイブへ移した時刻（ms）。60日後の自動削除判定に使う */
  archivedAt?: number;
  /** 最後にアクティブ化した時刻（ms）。「最近操作した順」の並べ替えに使う */
  lastOpAt?: number;
  /** サイドバー項目のテーマ対応背景色 */
  backgroundColor?: WorkspaceBackgroundColor;
  /** 表示上の束ねのみ。WorkspaceGroup.id を保持する */
  group?: string;
  /** 同じ親階層でのサイドバー表示順。未指定の旧データは従来順へフォールバックする */
  sidebarOrder?: number;
  shellKind: ShellKind;
  broadcast: boolean;
  /** Enterだけをこのセッションの全ペインへ送る */
  autoEnter: boolean;
  /** 一斉入力の追加送信先セッション ID（自分自身は含めない）。空なら従来どおり
      このセッション内で閉じる。**ランタイム専用で session.json には保存しない**
      （起動直後は必ず空 = セッション内のみ）。一斉入力を切ると同時に空にする */
  broadcastTargets: Set<string>;
  root: TreeNode | null;
  /** このセッション専用の絶対配置レイヤー。#grid の子 */
  layer: HTMLDivElement;
  panes: Map<string, Pane>;
  /** 常設表示する直近の状態。未読を消してもクリアせず、保存はしない */
  activity: "done";
  /** 未読の完了通知。アクティブ化・アプリ復帰でクリア。保存しない */
  attention: "done" | "waiting" | null;
};

/** session.json に保存する1セッション分のデータ。実行中の Pane は含めず、
    復元に必要な構成・起動情報・スクロールバックだけを持つ。 */
export type SerializedWorkspace = {
  id: string;
  name: string;
  note?: string;
  pinned?: boolean;
  /** 通常の一覧から退避し、アーカイブフィルターだけに表示する */
  archived?: boolean;
  /** アーカイブへ移した時刻（ms）。60日後の自動削除判定に使う */
  archivedAt?: number;
  /** 最後にアクティブ化した時刻（ms）。再起動後も「最近操作した順」を保つ */
  lastOpAt?: number;
  backgroundColor?: WorkspaceBackgroundColor;
  /** WorkspaceGroup.id。復元時にグループが無ければトップレベルへ退避する */
  group?: string;
  /** 同じ親階層でのサイドバー表示順 */
  sidebarOrder?: number;
  shellKind: ShellKind;
  broadcast: boolean;
  /** Enterだけをこのセッションの全ペインへ送る */
  autoEnter?: boolean;
  root: SerializedNode;
};

/** 最近削除したセッション。originalIndex は元の表示位置へ戻すためのヒント。 */
export type DeletedWorkspace = SerializedWorkspace & {
  deletedAt: number;
  originalIndex?: number;
};

export type SessionV1 = { version: 1; broadcast: boolean; root: SerializedNode };

/** v3 までのグループは名前を Workspace.group に直接保存していた */
export type SessionV3 = {
  version: number;
  activeId: string;
  collapsedGroups?: string[];
  explorer?: { open?: boolean; showHidden?: boolean; favorites?: string[] };
  /** アプリ設定。optional なので旧ファイルもそのまま読める */
  settings?: {
    theme?: string;
    /** 対応言語コード（BCP47）。未知の値は boot() で既定言語に落とす */
    language?: string;
    notifications?: boolean;
    /** Enterキーだけを全セッションの全ペインへ送るモード */
    autoEnter?: boolean;
    /** v3 までは文字列配列（全部が汎用）。リポジトリ専用は { text, repo } で持つ */
    quickPhrases?: Array<string | { text?: string; repo?: string }>;
    /** 新規セッションの場所フライアウトに出す「最近使った場所」（新しい順） */
    recentDirs?: string[];
    /** ターミナル上部の帯をたたんだ状態。開くまで開かないよう保存する */
    collapsed?: { changes?: boolean; quickPhrases?: boolean; oneLine?: true };
    /** worktree の作成先と Issue 実行で最後に選んだベースブランチを覚えておく */
    worktree?: {
      location?: "inside" | "outside";
      insideDir?: string;
      outsideDir?: string;
      issueBaseRef?: string;
    };
    /** ペアモードの実装役・レビュー役の既定起動コマンド（設定パネルで変更・入れ替え可能） */
    pair?: { implCmd?: string; reviewCmd?: string };
  };
  workspaces: Array<{
    id: string;
    name: string;
    note?: string;
    group?: string;
    shellKind: ShellKind;
    broadcast: boolean;
    autoEnter?: boolean;
    root: SerializedNode;
  }>;
};

/** v4 = グループを独立エンティティ化し、空グループと親子階層に対応 */
export type SessionV4 = Omit<SessionV3, "workspaces"> & {
  groups: WorkspaceGroup[];
  workspaces: SerializedWorkspace[];
};

/** v5 = 最近削除したセッションを永続化し、再起動後も履歴ごと復元できる */
export type SessionV5 = Omit<SessionV4, "version"> & {
  version: 5;
  deletedWorkspaces: DeletedWorkspace[];
};

export type FsEntry = { name: string; isDir: boolean };
export type FsListing = { entries: FsEntry[]; truncated: boolean };
/** 配下検索のヒット1件。depth は検索起点からの階層（1 = 直下） */
export type FsMatch = { path: string; name: string; isDir: boolean; parent: string; depth: number };
export type FsSearchResult = { matches: FsMatch[]; truncated: boolean };
