//! Files パネルから選んだファイル / フォルダを、右クリックしたフォルダへコピーする。
//!
//! 誤って既存内容を失わないよう、同名の既存エントリや選択内の同名はコピー開始前に拒否する。
//! シンボリックリンクはコピー先の外へ辿る危険があるため、インポート対象にしない。

use std::{
    collections::HashSet,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

fn import_destination(source: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let name = source
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("invalid source path: {}", source.display()))?;
    Ok(dest_dir.join(name))
}

/// コピー開始前にディレクトリ全体を走査し、途中で追うべきでないエントリを拒否する。
fn validate_directory(source: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let child = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "symbolic links cannot be imported: {}",
                child.display()
            ));
        }
        if file_type.is_dir() {
            validate_directory(&child)?;
        } else if !file_type.is_file() {
            return Err(format!("unsupported file type: {}", child.display()));
        }
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_child = entry.path();
        let destination_child = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "symbolic links cannot be imported: {}",
                source_child.display()
            ));
        }
        if file_type.is_dir() {
            copy_directory(&source_child, &destination_child)?;
        } else if file_type.is_file() {
            fs::copy(&source_child, &destination_child).map_err(|e| e.to_string())?;
        } else {
            return Err(format!("unsupported file type: {}", source_child.display()));
        }
    }
    Ok(())
}

/// インポートの本体。ファイルシステムに変更を加える前にすべての入力を検査する。
fn import_entries(dest_dir: &str, sources: &[String]) -> Result<(), String> {
    let destination_dir = Path::new(dest_dir);
    let destination_meta = fs::metadata(destination_dir).map_err(|e| e.to_string())?;
    if !destination_meta.is_dir() {
        return Err(format!(
            "destination is not a directory: {}",
            destination_dir.display()
        ));
    }
    let destination_canonical = fs::canonicalize(destination_dir).map_err(|e| e.to_string())?;

    let mut planned: Vec<(PathBuf, PathBuf, bool)> = Vec::with_capacity(sources.len());
    let mut names = HashSet::<OsString>::new();
    for source_string in sources {
        let source = PathBuf::from(source_string);
        let file_type = fs::symlink_metadata(&source)
            .map_err(|e| e.to_string())?
            .file_type();
        if file_type.is_symlink() {
            return Err(format!(
                "symbolic links cannot be imported: {}",
                source.display()
            ));
        }
        if !file_type.is_file() && !file_type.is_dir() {
            return Err(format!("unsupported file type: {}", source.display()));
        }

        let destination = import_destination(&source, destination_dir)?;
        let name = source
            .file_name()
            .ok_or_else(|| format!("invalid source path: {}", source.display()))?
            .to_os_string();
        if !names.insert(name) {
            return Err(format!("duplicate import name: {}", source.display()));
        }
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(format!("already exists: {}", destination.display()));
        }

        let is_dir = file_type.is_dir();
        if is_dir {
            let source_canonical = fs::canonicalize(&source).map_err(|e| e.to_string())?;
            if destination_canonical.starts_with(&source_canonical) {
                return Err("cannot import a folder into itself".to_string());
            }
            validate_directory(&source)?;
        }
        planned.push((source, destination, is_dir));
    }

    for (source, destination, is_dir) in planned {
        if is_dir {
            copy_directory(&source, &destination)?;
        } else {
            fs::copy(&source, &destination).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Files パネルの右クリックメニューで選んだエントリを、対象フォルダへコピーする。
#[tauri::command]
pub(crate) async fn fs_import(dest_dir: String, sources: Vec<String>) -> Result<(), String> {
    if sources.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || import_entries(&dest_dir, &sources))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempRepo;

    #[test]
    fn imports_a_file_and_folder_without_removing_the_sources() {
        let tmp = TempRepo::new();
        let source = tmp.0.join("source");
        let destination = tmp.0.join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(source.join("note.txt"), "note").unwrap();
        fs::create_dir(source.join("folder")).unwrap();
        fs::write(source.join("folder/nested.txt"), "nested").unwrap();

        import_entries(
            &destination.to_string_lossy(),
            &[
                source.join("note.txt").to_string_lossy().into_owned(),
                source.join("folder").to_string_lossy().into_owned(),
            ],
        )
        .unwrap();

        assert_eq!(fs::read_to_string(source.join("note.txt")).unwrap(), "note");
        assert_eq!(
            fs::read_to_string(source.join("folder/nested.txt")).unwrap(),
            "nested"
        );
        assert_eq!(
            fs::read_to_string(destination.join("note.txt")).unwrap(),
            "note"
        );
        assert_eq!(
            fs::read_to_string(destination.join("folder/nested.txt")).unwrap(),
            "nested"
        );
    }

    #[test]
    fn rejects_a_collision_before_copying_anything() {
        let tmp = TempRepo::new();
        let source = tmp.0.join("source");
        let destination = tmp.0.join("destination");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(source.join("first.txt"), "first").unwrap();
        fs::write(source.join("taken.txt"), "new").unwrap();
        fs::write(destination.join("taken.txt"), "existing").unwrap();

        let err = import_entries(
            &destination.to_string_lossy(),
            &[
                source.join("first.txt").to_string_lossy().into_owned(),
                source.join("taken.txt").to_string_lossy().into_owned(),
            ],
        )
        .unwrap_err();

        assert!(err.contains("already exists"), "{err}");
        assert!(!destination.join("first.txt").exists());
        assert_eq!(
            fs::read_to_string(destination.join("taken.txt")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn rejects_copying_a_folder_into_its_own_descendant() {
        let tmp = TempRepo::new();
        let source = tmp.0.join("source");
        fs::create_dir(&source).unwrap();
        fs::create_dir(source.join("inside")).unwrap();

        let err = import_entries(
            &source.join("inside").to_string_lossy(),
            &[source.to_string_lossy().into_owned()],
        )
        .unwrap_err();

        assert!(err.contains("into itself"), "{err}");
    }
}
