//! Disable idle composer output for manual Codex launches on every installation.
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(crate) fn disable_idle_whimsy() -> io::Result<()> {
    let home = std::env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::env::home_dir().map(|home| home.join(".codex")))
        .ok_or_else(|| io::Error::other("Codex home directory is unavailable"))?;
    update_config(&home.join("config.toml"))
}

fn update_config(path: &Path) -> io::Result<()> {
    // Keep an existing symlink (for example a dotfiles checkout) intact.
    let path = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => path.canonicalize()?,
        Ok(_) => path.to_path_buf(),
        Err(error) if error.kind() == io::ErrorKind::NotFound => path.to_path_buf(),
        Err(error) => return Err(error),
    };
    let original = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error),
    };
    let mut document = original
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if document.get("tui").is_none() {
        document["tui"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let tui = document["tui"].as_table_like_mut().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Codex tui config is not a table",
        )
    })?;
    if tui.get("whimsy").and_then(toml_edit::Item::as_bool) == Some(false) {
        return Ok(());
    }
    let mut disabled = toml_edit::Value::from(false);
    if let Some(value) = tui.get("whimsy").and_then(toml_edit::Item::as_value) {
        *disabled.decor_mut() = value.decor().clone();
    }
    tui.insert("whimsy", toml_edit::Item::Value(disabled));
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("Missing config parent"))?;
    std::fs::create_dir_all(parent)?;
    let mut replacement = tempfile::NamedTempFile::new_in(parent)?;
    if let Ok(metadata) = std::fs::metadata(&path) {
        replacement
            .as_file()
            .set_permissions(metadata.permissions())?;
    }
    replacement.write_all(document.to_string().as_bytes())?;
    replacement.as_file().sync_all()?;
    // Never truncate the real config if parsing or writing fails.
    replacement.persist(&path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::update_config;

    #[test]
    fn preserves_settings_comments_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "# user settings\nmodel = 'example'\n[tui]\nwhimsy = true # decoration\nanimations = true\n").unwrap();
        update_config(&path).unwrap();
        let updated = std::fs::read_to_string(&path).unwrap();
        assert_eq!(updated, "# user settings\nmodel = 'example'\n[tui]\nwhimsy = false # decoration\nanimations = true\n");
        update_config(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), updated);
    }

    #[test]
    fn creates_config_and_supports_inline_tui() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new/config.toml");
        update_config(&path).unwrap();
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("whimsy = false"));
        std::fs::write(&path, "tui = { animations = true, whimsy = true }\n").unwrap();
        update_config(&path).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("animations = true"));
        assert!(text.contains("whimsy = false"));
    }

    #[test]
    fn invalid_config_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        for original in ["[broken", "tui = true\n"] {
            std::fs::write(&path, original).unwrap();
            assert!(update_config(&path).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
    }

    #[cfg(unix)]
    #[test]
    fn preserves_symlink_and_file_permissions() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("dotfiles.toml");
        let path = dir.path().join("config.toml");
        std::fs::write(&target, "[tui]\nwhimsy = true\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
        symlink(&target, &path).unwrap();
        update_config(&path).unwrap();
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("whimsy = false"));
        assert_eq!(
            std::fs::metadata(target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
