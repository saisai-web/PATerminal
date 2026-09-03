use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // Windows のアプリケーションマニフェストは tauri-build に任せず、下の
    // embed_windows_manifest() で全ターゲット共通のリソースとして入れる。
    // tauri-build（embed-resource の compile()）は `cargo:rustc-link-arg-bins` で
    // 本体 exe にしかリンクしないため、lib のテスト exe にマニフェストが入らず、
    // muda / rfd が import する TaskDialogIndirect（Common Controls v6 が必要）を
    // ローダーが解決できずに STATUS_ENTRYPOINT_NOT_FOUND で起動できなくなる。
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if let Err(error) = tauri_build::try_build(attributes) {
        println!("{error:#}");
        std::process::exit(1);
    }
    embed_windows_manifest();
}

/// `windows/app.manifest` を RT_MANIFEST リソースにして、bin / lib テスト / 統合テストの
/// すべての実行ファイルへリンクする（`cargo:rustc-link-arg`。`-tests` は統合テストにしか効かない）。
/// 本体の version / icon リソースはマニフェスト無しで tauri-build が別に作るので重複しない。
fn embed_windows_manifest() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("windows")
        .join("app.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let rc = out_dir.join("manifest.rc");
    // 1 = CREATEPROCESS_MANIFEST_RESOURCE_ID, 24 = RT_MANIFEST
    let manifest_path = manifest.display().to_string().replace('\\', "\\\\");
    fs::write(&rc, format!("1 24 \"{manifest_path}\"\n")).expect("write manifest.rc");
    embed_resource::compile_for_everything(&rc, embed_resource::NONE)
        .manifest_required()
        .expect("compile the Windows manifest resource");
}
