//! git worktree の作成・一覧・削除。
//!
//! - `path`   … 格納先パスの解決（配下 / 外の2モード。Git は呼ばない純粋関数）
//! - `ignore` … 「リポジトリ配下」モードでの `.gitignore` 追記
//! - `create` … ベース候補の列挙と `worktree add`
//! - `list`   … `worktree list --porcelain` の解析と `worktree remove`

pub(crate) mod create;
mod ignore;
pub(crate) mod list;
mod path;
