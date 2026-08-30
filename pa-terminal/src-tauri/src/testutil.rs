use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP_REPO: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TempRepo(pub(crate) PathBuf);

impl TempRepo {
    pub(crate) fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "paterminal-git-test-{}-{nonce}-{}",
            std::process::id(),
            NEXT_TEMP_REPO.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn test_git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    if args.first() == Some(&"init") {
        disable_eol_conversion(root, args);
    }
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// 作ったばかりのテスト用リポジトリで改行変換を止める。
///
/// Windows の開発機は `core.autocrlf=true` が既定なので、テストが `"first\n"` を書いて
/// コミットしても、`git_reset_to_commit` / `git_stash`（本番コード = リポジトリの設定に従う）
/// のチェックアウトで `"first\r\n"` に戻ってしまい、内容の比較が OS 依存になる。
/// リポジトリ側の設定で殺すので、本番コードの経路を通しても効く。
fn disable_eol_conversion(root: &Path, init_args: &[&str]) {
    if init_args.contains(&"--bare") {
        return; // 作業ツリーが無いので変換も起きない
    }
    // `init --quiet <dir>` のようにディレクトリを渡された場合はそちらが新しいリポジトリ
    let target = init_args
        .iter()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(|a| root.join(a))
        .unwrap_or_else(|| root.to_path_buf());
    for (key, value) in [("core.autocrlf", "false"), ("core.eol", "lf")] {
        let out = Command::new("git")
            .arg("-C")
            .arg(&target)
            .args(["config", key, value])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git config {key} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

/// 常に成功するだけの `gh` スタブ。GitHub へ出ていく部分だけを黙らせ、
/// git の動き（push / ref 作成）は本物の bare remote で検証するために使う。
pub(crate) fn gh_stub(dir: &Path) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let gh = dir.join("gh");
        fs::write(&gh, "#!/bin/sh\nexit 0\n").unwrap();
        let mut permissions = fs::metadata(&gh).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&gh, permissions).unwrap();
        gh
    }
    #[cfg(windows)]
    {
        let gh = dir.join("gh.cmd");
        fs::write(&gh, "@echo off\r\nexit /b 0\r\n").unwrap();
        gh
    }
}
