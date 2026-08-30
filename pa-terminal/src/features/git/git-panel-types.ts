// エクスプローラー下部の git セクションで使う Rust コマンド / gh CLI のレスポンス型。
// 型だけを集めたモジュールなので、実行時のコードは一切持たない。

export type GitCommit = { hash: string; time: number; author: string; refs: string; subject: string };
export type GitLog = {
  repo: boolean;
  root: string | null;
  branch: string | null;
  detached: boolean;
  commits: GitCommit[];
};
export type PrComment = {
  author: string;
  body: string;
  createdAt: string;
  kind: "comment" | "review" | "inline";
  state: string | null;
  /** inline のみ: 対象ファイルパス */
  path: string | null;
  /** inline のみ: 対象行番号 */
  line: number | null;
  /** inline のみ: レビュー時点の対象行コード */
  code: string | null;
};
export type PrFile = {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
};
export type PrInfo = {
  found: boolean;
  number: number | null;
  title: string | null;
  state: string | null; // OPEN / CLOSED / MERGED
  url: string | null;
  author: string | null;
  body: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PrFile[];
  comments: PrComment[];
};
export type PrSummary = {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  updatedAt: string;
};
/** error は available:false のときだけ入る gh の生メッセージ（gh 不在・未認証・タイムアウト等） */
export type PrList = { available: boolean; prs: PrSummary[]; error?: string };
export type IssueSummary = {
  number: number;
  title: string;
  state: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
  updatedAt: string;
};
export type IssueList = { available: boolean; issues: IssueSummary[] };
export type IssueComment = { author: string; body: string; createdAt: string };
export type IssueInfo = {
  found: boolean;
  number: number | null;
  title: string | null;
  state: string | null;
  url: string | null;
  author: string | null;
  body: string | null;
  labels: string[];
  comments: IssueComment[];
};
export type IssueBranchLink = { branch: string; remote: string };
