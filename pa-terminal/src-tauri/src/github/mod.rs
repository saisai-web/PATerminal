//! gh CLI 経由の GitHub 連携。
//!
//! - `gh`    … gh の起動（実行パス解決・環境変数・タイムアウト・失敗理由）
//! - `pr`    … Pull Request（一覧 / 詳細 / 差分）
//! - `issue` … Issue（一覧 / 詳細 / linked branch）
//!
//! gh を spawn するのは `gh` モジュールだけ。`pr` / `issue` は JSON の解釈に専念する。

mod gh;
pub(crate) mod issue;
pub(crate) mod pr;
