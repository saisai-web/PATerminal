//! PTY のロケール（文字化け対策）。
//!
//! Finder / Dock から起動した GUI アプリの環境には LANG が無い（Terminal.app は
//! 起動時に自分で設定している）。そのまま PTY を起動するとシェルは C ロケールになり、
//! zsh の行編集がマルチバイト文字を `<0081>` のようなバイト表示に落とす＝文字化けする。
//! PATH と同じ考え方で、UTF-8 ロケールが無ければ補う。

use std::sync::OnceLock;

/// ロケール名の表記ゆれを吸収する。`locale -a` の出力は macOS が `ja_JP.UTF-8`、
/// glibc が `ja_JP.utf8` と割れるため、比較用に小文字化して `-` を落とす。
fn normalize_locale_name(name: &str) -> String {
    name.trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| *c != '-')
        .collect()
}

fn is_utf8_locale(name: &str) -> bool {
    normalize_locale_name(name).contains("utf8")
}

/// `defaults read -g AppleLocale` の値を POSIX ロケール名にする。
/// `ja_JP@calendar=japanese` のような修飾子は落とし、`zh-Hans_JP` のように
/// POSIX 名にならない表記は諦める（呼び出し側が既定へ退避する）。
fn apple_locale_to_utf8_name(raw: &str) -> Option<String> {
    let base = raw.split('@').next()?.trim();
    let (lang, region) = base.split_once('_')?;
    let lang_ok = (2..=3).contains(&lang.len()) && lang.chars().all(|c| c.is_ascii_lowercase());
    let region_ok = region.len() == 2 && region.chars().all(|c| c.is_ascii_uppercase());
    if !lang_ok || !region_ok {
        return None;
    }
    Some(format!("{lang}_{region}.UTF-8"))
}

/// 実在する UTF-8 ロケールを選ぶ。地域設定（`en_JP` など）が OS に無いこともあるので
/// `locale -a` に載っているものだけを採用し、載っていなければ既定へ退避する。
fn pick_utf8_locale(preferred: Option<&str>, available: &[String]) -> String {
    const FALLBACK: &str = "en_US.UTF-8";
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(p) = preferred {
        candidates.push(p);
    }
    candidates.push(FALLBACK);
    candidates.push("C.UTF-8");
    for cand in candidates {
        let want = normalize_locale_name(cand);
        if let Some(hit) = available.iter().find(|a| normalize_locale_name(a) == want) {
            return hit.clone(); // 表記は locale -a のものをそのまま使う
        }
    }
    if available.is_empty() {
        // locale -a が使えない環境。検証はできないが、C ロケールのままよりはましなので使う
        return preferred.unwrap_or(FALLBACK).to_string();
    }
    // 候補がどれも無い OS でも、UTF-8 でありさえすれば化けないので拾う
    available
        .iter()
        .find(|a| is_utf8_locale(a))
        .cloned()
        .unwrap_or_else(|| FALLBACK.to_string())
}

fn available_locales() -> Vec<String> {
    let program = if cfg!(target_os = "macos") {
        "/usr/bin/locale" // GUI 起動で PATH が痩せていても引ける
    } else {
        "locale"
    };
    let Ok(out) = std::process::Command::new(program).arg("-a").output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// OS の地域設定に沿った UTF-8 ロケール名。subprocess を2つ起こすので1回だけ解決する。
fn system_utf8_locale() -> &'static str {
    static CACHE: OnceLock<String> = OnceLock::new();
    CACHE.get_or_init(|| {
        let preferred = if cfg!(target_os = "macos") {
            std::process::Command::new("/usr/bin/defaults")
                .args(["read", "-g", "AppleLocale"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .and_then(|o| apple_locale_to_utf8_name(String::from_utf8_lossy(&o.stdout).trim()))
        } else {
            None
        };
        pick_utf8_locale(preferred.as_deref(), &available_locales())
    })
}

/// UTF-8 を補うために設定すべき環境変数名。既に UTF-8 なら何もしない（None）。
/// LC_ALL は他をすべて上書きする明示指定なので、設定されている限り尊重して触らない。
fn locale_env_key(
    lc_all: Option<&str>,
    lc_ctype: Option<&str>,
    lang: Option<&str>,
) -> Option<&'static str> {
    if lc_all.is_some() {
        return None;
    }
    if let Some(ctype) = lc_ctype {
        // LC_CTYPE は LANG より強い。非 UTF-8 のままだと LANG を足しても効かない
        return (!is_utf8_locale(ctype)).then_some("LC_CTYPE");
    }
    match lang {
        Some(lang) if is_utf8_locale(lang) => None,
        _ => Some("LANG"),
    }
}

/// PTY に足すべきロケール環境変数（キーと値）。
pub(crate) fn locale_env_override() -> Option<(&'static str, String)> {
    if cfg!(windows) {
        // Windows は LANG ではなくコンソールのコードページで決まる。UTF-8 化は
        // シェル起動時のブートストラップ（`pty::shell`）が担当する
        return None;
    }
    let get = |key: &str| std::env::var(key).ok().filter(|v| !v.trim().is_empty());
    let key = locale_env_key(
        get("LC_ALL").as_deref(),
        get("LC_CTYPE").as_deref(),
        get("LANG").as_deref(),
    )?;
    Some((key, system_utf8_locale().to_string()))
}

#[cfg(test)]
mod tests {
    use super::{apple_locale_to_utf8_name, is_utf8_locale, locale_env_key, pick_utf8_locale};

    #[test]
    fn utf8_locale_is_detected_regardless_of_spelling() {
        assert!(is_utf8_locale("ja_JP.UTF-8"));
        assert!(is_utf8_locale("en_US.utf8"));
        assert!(!is_utf8_locale("C"));
        assert!(!is_utf8_locale("POSIX"));
        assert!(!is_utf8_locale("ja_JP.eucJP"));
    }

    #[test]
    fn apple_locale_is_converted_only_for_posix_style_names() {
        assert_eq!(
            apple_locale_to_utf8_name("ja_JP@calendar=japanese").as_deref(),
            Some("ja_JP.UTF-8")
        );
        assert_eq!(
            apple_locale_to_utf8_name("en_US").as_deref(),
            Some("en_US.UTF-8")
        );
        assert_eq!(apple_locale_to_utf8_name("zh-Hans_JP"), None);
        assert_eq!(apple_locale_to_utf8_name("ja"), None);
    }

    #[test]
    fn utf8_locale_falls_back_when_the_region_locale_is_missing() {
        let available: Vec<String> = ["C", "en_US.UTF-8", "ja_JP.UTF-8"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // 地域設定のロケールがあればそれを使う（表記は locale -a のもの）
        assert_eq!(
            pick_utf8_locale(Some("ja_JP.UTF-8"), &available),
            "ja_JP.UTF-8"
        );
        // en_JP のような実在しない組み合わせは既定へ退避する
        assert_eq!(
            pick_utf8_locale(Some("en_JP.UTF-8"), &available),
            "en_US.UTF-8"
        );
        assert_eq!(pick_utf8_locale(None, &available), "en_US.UTF-8");
        // glibc の表記ゆれを吸収し、見つかった名前をそのまま返す
        let glibc: Vec<String> = ["C.utf8", "ja_JP.utf8"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(pick_utf8_locale(Some("ja_JP.UTF-8"), &glibc), "ja_JP.utf8");
        assert_eq!(pick_utf8_locale(Some("fr_FR.UTF-8"), &glibc), "C.utf8");
        // locale -a が使えなくても C ロケールのままにはしない
        assert_eq!(pick_utf8_locale(Some("ja_JP.UTF-8"), &[]), "ja_JP.UTF-8");
        assert_eq!(pick_utf8_locale(None, &[]), "en_US.UTF-8");
    }

    #[test]
    fn locale_is_supplemented_only_when_the_environment_lacks_utf8() {
        // GUI 起動（LANG 無し）＝文字化けする組み合わせ。ここを補うのが目的
        assert_eq!(locale_env_key(None, None, None), Some("LANG"));
        assert_eq!(locale_env_key(None, None, Some("C")), Some("LANG"));
        // ターミナルから起動して UTF-8 が来ているときは触らない
        assert_eq!(locale_env_key(None, None, Some("ja_JP.UTF-8")), None);
        assert_eq!(locale_env_key(None, Some("en_US.UTF-8"), Some("C")), None);
        // LC_CTYPE は LANG より強いので、非 UTF-8 ならそちらを上書きする
        assert_eq!(
            locale_env_key(None, Some("C"), Some("ja_JP.UTF-8")),
            Some("LC_CTYPE")
        );
        // LC_ALL は明示指定として尊重する
        assert_eq!(locale_env_key(Some("C"), None, None), None);
    }
}
