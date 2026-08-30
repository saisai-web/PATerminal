//! トライアル / ライセンス検証 / ソフトロックの状態管理。
//!
//! これは DRM ではない（指示書の大原則）。ソースは公開されており、チェックを外した
//! 自ビルドは設計上許容している。難読化やアンチデバッグに工数をかけない。
//! 迷ったらユーザーに有利な側へ倒す（検証失敗 = Grace、判定不能 = 通す）。
//!
//! ビルド2系統: デフォルト = 自ビルド（`Selfbuild`、ロック無し・トライアル記録も
//! 書かない）。`--features official` の公式ビルドだけがトライアル/ソフトロックを持つ。
//! ロジックは `official: bool` を引数で受ける純粋関数（state.rs）にし、cfg! は
//! このフラグ1つに閉じる（デフォルト features の cargo test で全ロジックがテストできる）。
//!
//! フロントのゲートは `LicenseStatus.locked` だけを見る。状態の内訳（Trial / Grace 等）は
//! 設定パネルとバナーの表示にのみ使う。

pub(crate) mod key;
pub(crate) mod polar;
pub(crate) mod state;
pub(crate) mod store;
pub(crate) mod trial;

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use key::{KeyInfo, KeyKind};
use state::{Computed, DAY};
use store::LicenseStore;

pub(crate) const IS_OFFICIAL: bool = cfg!(feature = "official");
pub(crate) const EULA_VERSION: &str = "1.0";
pub(crate) const EULA_EFFECTIVE_DATE: &str = "2026-08-24";
pub(crate) const EULA_URL: &str = "https://paralellterminal.com/eula";
const EULA_TEXT: &str = include_str!("../../../../LICENSE.md");
const EULA_AR_TEXT: &str = include_str!("../../../../legal/eula/ar.md");
const EULA_DE_TEXT: &str = include_str!("../../../../legal/eula/de.md");
const EULA_ES_TEXT: &str = include_str!("../../../../legal/eula/es.md");
const EULA_FR_TEXT: &str = include_str!("../../../../legal/eula/fr.md");
const EULA_HI_TEXT: &str = include_str!("../../../../legal/eula/hi.md");
const EULA_ID_TEXT: &str = include_str!("../../../../legal/eula/id.md");
const EULA_IT_TEXT: &str = include_str!("../../../../legal/eula/it.md");
const EULA_JA_TEXT: &str = include_str!("../../../../legal/eula/ja.md");
const EULA_KO_TEXT: &str = include_str!("../../../../legal/eula/ko.md");
const EULA_PT_BR_TEXT: &str = include_str!("../../../../legal/eula/pt-BR.md");
const EULA_RU_TEXT: &str = include_str!("../../../../legal/eula/ru.md");
const EULA_TH_TEXT: &str = include_str!("../../../../legal/eula/th.md");
const EULA_TR_TEXT: &str = include_str!("../../../../legal/eula/tr.md");
const EULA_VI_TEXT: &str = include_str!("../../../../legal/eula/vi.md");
const EULA_ZH_HANS_TEXT: &str = include_str!("../../../../legal/eula/zh-Hans.md");
const EULA_ZH_HANT_TEXT: &str = include_str!("../../../../legal/eula/zh-Hant.md");
const THIRD_PARTY_NOTICES_TEXT: &str = include_str!("../../../../THIRD_PARTY_NOTICES.md");

#[derive(Clone, Copy)]
struct EulaDocument {
    locale: &'static str,
    url: &'static str,
    text: &'static str,
    is_translation: bool,
}

fn visible_eula_text(raw: &'static str) -> &'static str {
    if raw.starts_with("<!--") {
        return raw.split_once("-->\n\n").map_or(raw, |(_, body)| body);
    }
    raw
}

fn resolve_eula(locale: Option<&str>) -> EulaDocument {
    let (locale, path, text) = match locale {
        Some("ja") => ("ja", "/ja/eula", EULA_JA_TEXT),
        Some("zh-Hans") => ("zh-Hans", "/zh-Hans/eula", EULA_ZH_HANS_TEXT),
        Some("zh-Hant") => ("zh-Hant", "/zh-Hant/eula", EULA_ZH_HANT_TEXT),
        Some("ko") => ("ko", "/ko/eula", EULA_KO_TEXT),
        Some("es") => ("es", "/es/eula", EULA_ES_TEXT),
        Some("pt-BR") => ("pt-BR", "/pt-BR/eula", EULA_PT_BR_TEXT),
        Some("fr") => ("fr", "/fr/eula", EULA_FR_TEXT),
        Some("de") => ("de", "/de/eula", EULA_DE_TEXT),
        Some("it") => ("it", "/it/eula", EULA_IT_TEXT),
        Some("ru") => ("ru", "/ru/eula", EULA_RU_TEXT),
        Some("ar") => ("ar", "/ar/eula", EULA_AR_TEXT),
        Some("hi") => ("hi", "/hi/eula", EULA_HI_TEXT),
        Some("id") => ("id", "/id/eula", EULA_ID_TEXT),
        Some("vi") => ("vi", "/vi/eula", EULA_VI_TEXT),
        Some("th") => ("th", "/th/eula", EULA_TH_TEXT),
        Some("tr") => ("tr", "/tr/eula", EULA_TR_TEXT),
        _ => ("en", "/eula", EULA_TEXT),
    };
    EulaDocument {
        locale,
        url: match path {
            "/ja/eula" => "https://paralellterminal.com/ja/eula",
            "/zh-Hans/eula" => "https://paralellterminal.com/zh-Hans/eula",
            "/zh-Hant/eula" => "https://paralellterminal.com/zh-Hant/eula",
            "/ko/eula" => "https://paralellterminal.com/ko/eula",
            "/es/eula" => "https://paralellterminal.com/es/eula",
            "/pt-BR/eula" => "https://paralellterminal.com/pt-BR/eula",
            "/fr/eula" => "https://paralellterminal.com/fr/eula",
            "/de/eula" => "https://paralellterminal.com/de/eula",
            "/it/eula" => "https://paralellterminal.com/it/eula",
            "/ru/eula" => "https://paralellterminal.com/ru/eula",
            "/ar/eula" => "https://paralellterminal.com/ar/eula",
            "/hi/eula" => "https://paralellterminal.com/hi/eula",
            "/id/eula" => "https://paralellterminal.com/id/eula",
            "/vi/eula" => "https://paralellterminal.com/vi/eula",
            "/th/eula" => "https://paralellterminal.com/th/eula",
            "/tr/eula" => "https://paralellterminal.com/tr/eula",
            _ => EULA_URL,
        },
        text: visible_eula_text(text),
        is_translation: locale != "en",
    }
}

#[derive(Default)]
pub(crate) struct LicenseState {
    store: Mutex<Option<LicenseStore>>,
    /// バックグラウンド再検証の試行間隔制御（1時間に1回まで）
    revalidate_attempt: Mutex<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LicenseStatus {
    official: bool,
    /// "selfbuild" | "trial" | "retrial" | "licensed" | "grace" | "locked"
    state: String,
    /// フロントのソフトロック判定はこれだけを見る
    locked: bool,
    days_left: Option<u32>,
    /// 自ビルド + 有効キー（設定画面の Supporter 表示）
    supporter: bool,
    key_masked: Option<String>,
    key_kind: Option<String>,
    retrial_available: bool,
    /// 未表示のバナー ID。表示したら license_banner_seen で既読化する
    banner: Option<String>,
    guide_pending: bool,
    /// 購入ページ（金額はアプリに持たない）
    checkout_url: String,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ActivateOutcome {
    Activated { status: LicenseStatus },
    /// デバイス上限。エラーで弾いて終わりにせず、一覧を返してその場で解除→続行させる
    DeviceLimit { devices: Vec<polar::Device> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateNotifyInfo {
    off: bool,
    /// 今回通知してよいか（1日1回制限を Rust 側で消化済み）
    due: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EulaStatus {
    official: bool,
    version: &'static str,
    effective_date: &'static str,
    accepted: bool,
    url: &'static str,
    text: &'static str,
    resolved_locale: &'static str,
    authoritative_locale: &'static str,
    is_translation: bool,
}

fn eula_acceptance_required(official: bool, accepted_version: Option<&str>) -> bool {
    official && accepted_version != Some(EULA_VERSION)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// store をロック内で読み書きするヘルパ。ロード済みでなければ license.json から読む。
/// 戻り値が Some のときだけ保存する（ロックは await をまたがない）。
fn with_store<T>(
    app: &AppHandle,
    state: &LicenseState,
    f: impl FnOnce(&mut LicenseStore) -> (T, bool),
) -> Result<T, String> {
    let mut guard = state.store.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(store::load(app)?);
    }
    let s = guard.as_mut().expect("loaded above");
    let (out, dirty) = f(s);
    if dirty {
        store::save(app, s)?;
    }
    Ok(out)
}

fn parse_current_key(store: &LicenseStore, now: u64) -> Option<KeyInfo> {
    let raw = store.key.as_deref()?;
    let pubkey = key::embedded_public_key()?;
    key::parse_and_verify(raw, &pubkey, now).ok()
}

fn computed_to_status(c: &Computed, store: &LicenseStore, key: Option<&KeyInfo>) -> LicenseStatus {
    let (state_str, locked, days_left, retrial_available) = match c {
        Computed::Selfbuild => ("selfbuild", false, None, false),
        Computed::Trial { days_left } => ("trial", false, Some(*days_left), false),
        Computed::Retrial { days_left } => ("retrial", false, Some(*days_left), false),
        Computed::Licensed => ("licensed", false, None, false),
        Computed::Grace { days_left } => ("grace", false, Some(*days_left), false),
        Computed::Locked { retrial_available } => ("locked", true, None, *retrial_available),
    };
    LicenseStatus {
        official: IS_OFFICIAL,
        state: state_str.to_string(),
        locked,
        days_left,
        supporter: !IS_OFFICIAL && key.is_some(),
        key_masked: store.key.as_deref().map(key::masked),
        key_kind: key.map(|k| match k.kind {
            KeyKind::Paid => "paid".to_string(),
            KeyKind::Dev => "dev".to_string(),
        }),
        retrial_available,
        banner: state::pending_banner(c, &store.banners_shown).map(String::from),
        // 初回ガイドは公式ビルドのトライアル中だけ。閉じたら二度と出さない
        guide_pending: matches!(c, Computed::Trial { .. }) && !store.guide_dismissed,
        checkout_url: polar::CHECKOUT_URL.to_string(),
    }
}

/// 状態の再計算 + 必要な永続化（last_seen / trial_start / locked_since）を1回で行う。
/// await を含まない同期処理（Mutex ガードを跨ぐ await を作らないため）。
fn refresh_status(app: &AppHandle, state: &LicenseState) -> Result<LicenseStatus, String> {
    let now = now_unix();
    let (status, revalidate_key) = with_store(app, state, |s| {
        let mut dirty = false;
        let eff = state::effective_now(now, s.last_seen);
        // 時計巻き戻し対策の記録。書き込みは1時間に1回に抑える
        if now > s.last_seen && now - s.last_seen > 3600 {
            s.last_seen = now;
            dirty = true;
        }
        // 公式ビルドの初回起動: トライアル開始を file + OS の両方に記録する。
        // 自ビルドでは何も書かない（ローカル機能は無期限、記録もナグもゼロ）
        if IS_OFFICIAL && s.trial_start.is_none() {
            let os = trial::os_trial_start_read();
            let merged = trial::merge_trial_start(None, os).unwrap_or(eff);
            s.trial_start = Some(merged);
            if os.is_none() {
                trial::os_trial_start_write(merged);
            }
            dirty = true;
        }
        let key = parse_current_key(s, eff);
        let computed = state::compute(IS_OFFICIAL, eff, s, key.as_ref());
        // Win-back の30日カウント: Locked へ入った時刻を記録し、抜けたらリセット
        match (&computed, s.locked_since) {
            (Computed::Locked { .. }, None) => {
                s.locked_since = Some(eff);
                dirty = true;
            }
            (Computed::Locked { .. }, Some(_)) => {}
            (_, Some(_)) => {
                s.locked_since = None;
                dirty = true;
            }
            _ => {}
        }
        // paid キーの7日ごと再検証が必要ならバックグラウンドで（呼び出しは待たせない）
        let revalidate_key = match (&computed, &key) {
            (Computed::Licensed | Computed::Grace { .. }, Some(k))
                if k.kind == KeyKind::Paid
                    && state::revalidation_due(eff, s.last_validation_ok) =>
            {
                k.polar_key.clone().map(|pk| (pk, s.activation_id.clone()))
            }
            _ => None,
        };
        (
            (computed_to_status(&computed, s, key.as_ref()), revalidate_key),
            dirty,
        )
    })?;

    if let Some((polar_key, activation_id)) = revalidate_key {
        maybe_spawn_revalidation(app.clone(), polar_key, activation_id);
    }
    Ok(status)
}

/// 起動ゲート専用。状態を読むだけで、トライアル開始・session 保存は行わない。
#[tauri::command]
pub(crate) async fn eula_status(
    app: AppHandle,
    state: State<'_, LicenseState>,
    locale: Option<String>,
) -> Result<EulaStatus, String> {
    let accepted = with_store(&app, &state, |s| {
        (
            !eula_acceptance_required(IS_OFFICIAL, s.accepted_eula_version.as_deref()),
            false,
        )
    })?;
    let document = resolve_eula(locale.as_deref());
    Ok(EulaStatus {
        official: IS_OFFICIAL,
        version: EULA_VERSION,
        effective_date: EULA_EFFECTIVE_DATE,
        accepted,
        url: document.url,
        text: document.text,
        resolved_locale: document.locale,
        authoritative_locale: "en",
        is_translation: document.is_translation,
    })
}

/// 現行版への明示同意だけを保存する。これが成功してからフロントが license_status を呼ぶ。
#[tauri::command]
pub(crate) async fn eula_accept(
    app: AppHandle,
    state: State<'_, LicenseState>,
    version: String,
) -> Result<(), String> {
    if version != EULA_VERSION {
        return Err("EULA version is no longer current; review the current version".into());
    }
    with_store(&app, &state, |s| {
        if s.accepted_eula_version.as_deref() == Some(EULA_VERSION) {
            return ((), false);
        }
        s.accepted_eula_version = Some(EULA_VERSION.to_string());
        s.eula_accepted_at = Some(now_unix());
        ((), true)
    })
}

/// 拒否時は終了するだけ。ライセンス・トライアル・session 状態を書かない。
#[tauri::command]
pub(crate) async fn eula_decline(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub(crate) async fn third_party_notices() -> &'static str {
    THIRD_PARTY_NOTICES_TEXT
}

/// 1時間に1回までのバックグラウンド再検証。成功したら last_validation_ok を刻む。
/// 失敗（Rejected / Unreachable）は何もしない = Grace の経過に任せる（即時遮断しない）。
fn maybe_spawn_revalidation(app: AppHandle, polar_key: String, activation_id: Option<String>) {
    {
        let state = app.state::<LicenseState>();
        let mut last = match state.revalidate_attempt.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let now = now_unix();
        if now.saturating_sub(*last) < 3600 {
            return;
        }
        *last = now;
    }
    tauri::async_runtime::spawn(async move {
        let version = app.package_info().version.to_string();
        let result = polar::validate(&polar_key, activation_id.as_deref(), &version).await;
        if result.is_ok() {
            let state = app.state::<LicenseState>();
            let _ = with_store(&app, &state, |s| {
                s.last_validation_ok = Some(now_unix());
                ((), true)
            });
        }
    });
}

#[tauri::command]
pub(crate) async fn license_status(
    app: AppHandle,
    state: State<'_, LicenseState>,
) -> Result<LicenseStatus, String> {
    refresh_status(&app, &state)
}

#[cfg(test)]
mod eula_tests {
    use super::{eula_acceptance_required, resolve_eula};

    #[test]
    fn official_build_requires_the_current_eula_version() {
        assert!(eula_acceptance_required(true, None));
        assert!(eula_acceptance_required(true, Some("0.9")));
        assert!(!eula_acceptance_required(true, Some("1.0")));
    }

    #[test]
    fn selfbuild_never_blocks_on_eula_state() {
        assert!(!eula_acceptance_required(false, None));
        assert!(!eula_acceptance_required(false, Some("0.9")));
    }

    #[test]
    fn resolves_all_supported_eula_locales_and_urls() {
        let mut texts = std::collections::HashSet::new();
        let cases = [
            ("en", "/eula"),
            ("ja", "/ja/eula"),
            ("zh-Hans", "/zh-Hans/eula"),
            ("zh-Hant", "/zh-Hant/eula"),
            ("ko", "/ko/eula"),
            ("es", "/es/eula"),
            ("pt-BR", "/pt-BR/eula"),
            ("fr", "/fr/eula"),
            ("de", "/de/eula"),
            ("it", "/it/eula"),
            ("ru", "/ru/eula"),
            ("ar", "/ar/eula"),
            ("hi", "/hi/eula"),
            ("id", "/id/eula"),
            ("vi", "/vi/eula"),
            ("th", "/th/eula"),
            ("tr", "/tr/eula"),
        ];
        for (locale, path) in cases {
            let document = resolve_eula(Some(locale));
            assert_eq!(document.locale, locale);
            assert_eq!(document.url, format!("https://paralellterminal.com{path}"));
            assert_eq!(document.is_translation, locale != "en");
            assert!(!document.text.starts_with("<!--"));
            assert!(document.text.contains("1.0"));
            if locale == "en" {
                assert!(document.text.contains("sole authoritative version"));
            } else {
                assert!(document.text.contains("LICENSE.md"));
            }
            texts.insert(document.text);
        }
        assert_eq!(texts.len(), 17);
    }

    #[test]
    fn unsupported_eula_locale_falls_back_to_authoritative_english() {
        for locale in [None, Some("en-US"), Some("pl"), Some("")] {
            let document = resolve_eula(locale);
            assert_eq!(document.locale, "en");
            assert_eq!(document.url, "https://paralellterminal.com/eula");
            assert!(!document.is_translation);
        }
    }
}

#[tauri::command]
pub(crate) async fn license_activate(
    app: AppHandle,
    state: State<'_, LicenseState>,
    key: String,
) -> Result<ActivateOutcome, String> {
    let now = now_unix();
    let pubkey = key::embedded_public_key().ok_or("public key unavailable")?;
    let info = key::parse_and_verify(&key, &pubkey, now).map_err(|e| e.message().to_string())?;
    let version = app.package_info().version.to_string();

    let mut activation_id: Option<String> = None;
    let mut validated = false;
    if info.kind == KeyKind::Paid {
        if let Some(polar_key) = &info.polar_key {
            match polar::activate(polar_key, &polar::device_label(), &version).await {
                Ok(a) => {
                    activation_id = Some(a.id);
                    validated = true;
                }
                Err(polar::PolarErr::Rejected(msg)) => {
                    // 上限到達は DeviceLimit として返す（弾いて終わりにしない）。
                    // Polar の現行 API は認証なしでアクティベーション一覧を返さないため
                    // devices は通常空になる（フロントは空なら「他の端末で解除してから
                    // 再試行」の案内を出す）。将来一覧が取れるようになれば自然に一覧表示へ戻る
                    if polar::is_activation_limit(&msg) {
                        let devices = match polar::validate(polar_key, None, &version).await {
                            Ok(v) => v.devices,
                            Err(_) => Vec::new(),
                        };
                        return Ok(ActivateOutcome::DeviceLimit { devices });
                    }
                    return Err(msg);
                }
                Err(polar::PolarErr::Unreachable(_)) => {
                    // 到達できないのはユーザーの落ち度ではない。キーは受理して
                    // Grace 30日の起点を刻む（オフライン環境・Polar 未設定でも詰まない）
                    validated = true;
                }
            }
        }
    }

    with_store(&app, &state, |s| {
        s.key = Some(key.trim().to_string());
        s.activation_id = activation_id.clone();
        if validated {
            s.last_validation_ok = Some(now);
        }
        ((), true)
    })?;
    let status = refresh_status(&app, &state)?;
    Ok(ActivateOutcome::Activated { status })
}

#[tauri::command]
pub(crate) async fn license_deactivate(
    app: AppHandle,
    state: State<'_, LicenseState>,
) -> Result<LicenseStatus, String> {
    let now = now_unix();
    // Polar 側のアクティベーション解除はベストエフォート（失敗してもローカルは解除する）
    let (polar_key, activation_id) = with_store(&app, &state, |s| {
        let key = parse_current_key(s, now).and_then(|k| k.polar_key);
        ((key, s.activation_id.clone()), false)
    })?;
    if let (Some(pk), Some(aid)) = (&polar_key, &activation_id) {
        let version = app.package_info().version.to_string();
        let _ = polar::deactivate(pk, aid, &version).await;
    }
    with_store(&app, &state, |s| {
        s.key = None;
        s.activation_id = None;
        s.last_validation_ok = None;
        ((), true)
    })?;
    refresh_status(&app, &state)
}

#[tauri::command]
pub(crate) async fn license_devices(
    app: AppHandle,
    state: State<'_, LicenseState>,
) -> Result<Vec<polar::Device>, String> {
    let now = now_unix();
    let (polar_key, activation_id) = with_store(&app, &state, |s| {
        let key = parse_current_key(s, now).and_then(|k| k.polar_key);
        ((key, s.activation_id.clone()), false)
    })?;
    let Some(pk) = polar_key else {
        return Ok(Vec::new());
    };
    let version = app.package_info().version.to_string();
    match polar::validate(&pk, activation_id.as_deref(), &version).await {
        Ok(v) => Ok(v.devices),
        Err(polar::PolarErr::Rejected(m)) | Err(polar::PolarErr::Unreachable(m)) => Err(m),
    }
}

#[tauri::command]
pub(crate) async fn license_device_remove(
    app: AppHandle,
    state: State<'_, LicenseState>,
    activation_id: String,
) -> Result<(), String> {
    let now = now_unix();
    let polar_key = with_store(&app, &state, |s| {
        (parse_current_key(s, now).and_then(|k| k.polar_key), false)
    })?;
    let Some(pk) = polar_key else {
        return Err("no key".into());
    };
    let version = app.package_info().version.to_string();
    match polar::deactivate(&pk, &activation_id, &version).await {
        Ok(()) => {
            // 自分のデバイスを外した場合は次回 activate で取り直す
            with_store(&app, &state, |s| {
                if s.activation_id.as_deref() == Some(activation_id.as_str()) {
                    s.activation_id = None;
                    ((), true)
                } else {
                    ((), false)
                }
            })
        }
        Err(polar::PolarErr::Rejected(m)) | Err(polar::PolarErr::Unreachable(m)) => Err(m),
    }
}

/// Win-back: Locked 30日経過後に一度だけ7日間の再トライアルを付与する
#[tauri::command]
pub(crate) async fn license_retrial(
    app: AppHandle,
    state: State<'_, LicenseState>,
) -> Result<LicenseStatus, String> {
    let now = now_unix();
    with_store(&app, &state, |s| {
        let eff = state::effective_now(now, s.last_seen);
        let key = parse_current_key(s, eff);
        let computed = state::compute(IS_OFFICIAL, eff, s, key.as_ref());
        if !matches!(
            computed,
            Computed::Locked {
                retrial_available: true
            }
        ) {
            return (Err("retrial not available".to_string()), false);
        }
        s.retrial_used = true;
        s.retrial_start = Some(eff);
        s.locked_since = None;
        (Ok(()), true)
    })??;
    refresh_status(&app, &state)
}

#[tauri::command]
pub(crate) async fn license_banner_seen(
    app: AppHandle,
    state: State<'_, LicenseState>,
    id: String,
) -> Result<(), String> {
    with_store(&app, &state, |s| {
        if s.banners_shown.iter().any(|b| *b == id) {
            ((), false)
        } else {
            s.banners_shown.push(id.clone());
            ((), true)
        }
    })
}

#[tauri::command]
pub(crate) async fn license_guide_dismiss(
    app: AppHandle,
    state: State<'_, LicenseState>,
) -> Result<(), String> {
    with_store(&app, &state, |s| {
        if s.guide_dismissed {
            ((), false)
        } else {
            s.guide_dismissed = true;
            ((), true)
        }
    })
}

/// 自ビルドの新バージョン通知の設定と1日1回制御。
/// off=None は「いま通知してよいか」の問い合わせ（due を返すと同時に当日分を消費する）。
#[tauri::command]
pub(crate) async fn license_update_notify(
    app: AppHandle,
    state: State<'_, LicenseState>,
    off: Option<bool>,
) -> Result<UpdateNotifyInfo, String> {
    let now = now_unix();
    with_store(&app, &state, |s| {
        if let Some(v) = off {
            s.update_notify_off = v;
            return (
                UpdateNotifyInfo {
                    off: v,
                    due: false,
                },
                true,
            );
        }
        if s.update_notify_off {
            return (
                UpdateNotifyInfo {
                    off: true,
                    due: false,
                },
                false,
            );
        }
        let due = match s.last_update_notify {
            Some(t) => now.saturating_sub(t) >= DAY,
            None => true,
        };
        if due {
            s.last_update_notify = Some(now);
        }
        (UpdateNotifyInfo { off: false, due }, due)
    })
}
