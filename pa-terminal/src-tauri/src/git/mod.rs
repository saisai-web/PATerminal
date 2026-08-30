//! git 操作。フロントの機能単位で分けてある:
//!
//! - `run`   … git プロセスの実行とエラー要約（他すべての土台）
//! - `status`… 変更検出（変更ストリップ / サイドバーのバッジ）
//! - `diff`  … ファイル / コミット / 作業ツリーの差分
//! - `commit`… コミット・Stash・巻き戻し（作業ツリーを書き換える操作）
//! - `branch`… ブランチ一覧・切替・Push / Fetch / Pull
//! - `log`   … コミット履歴
//!
//! `#[tauri::command]` は定義したモジュールのパスで `generate_handler!` へ登録する
//! （コマンドの登録は再エクスポートでは辿れない）。ここで公開するのは
//! `github` / `worktree` が使う共通ヘルパだけ。

pub(crate) mod branch;
pub(crate) mod commit;
pub(crate) mod diff;
pub(crate) mod log;
mod run;
pub(crate) mod status;

pub(crate) use branch::git_remotes;
pub(crate) use diff::{limited_git_patch, patch_line_totals, GitCommitDiff};
pub(crate) use run::{git_output_text, run_git};
