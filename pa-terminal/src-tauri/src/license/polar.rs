//! Polar のライセンス検証 / アクティベーション API。
//!
//! 送信するのは「キー・organization_id・activation の id / label・User-Agent
//! （PATerminal/{version}）」のみ。テレメトリ・利用状況は一切送らない（計測ゼロ）。
//!
//! POLAR_ORG_ID / CHECKOUT_URL は本番値を設定済み（2026-08-16。docs/polar-setup-progress.md）。
//! プレースホルダに戻した場合は照会を Unreachable として扱う
//! （= Grace 側へ倒れる。ユーザーに不利にならない）。
//!
//! エンドポイントは Polar の customer-portal license-keys API
//! （https://docs.polar.sh/api-reference/customer-portal/license-keys）。
//! 2026-08-15 に sandbox で疎通確認済み（docs/polar-setup.md §7）:
//! - validate / activate はボディ・レスポンスとも想定どおり（activate は
//!   トップレベル `id` がアクティベーション ID）
//! - deactivate は **204 No Content（空ボディ）**。post() は空ボディを許容する
//! - 上限到達は activate の 403 `{"error":"NotPermitted","detail":"License key
//!   activation limit already reached"}`（`is_activation_limit` で判定）
//! - **アクティベーション一覧は認証なしでは取得できない**（validate レスポンスに
//!   `activations` 配列は無く、一覧 GET は customer_session / org トークン必須）。
//!   parse_devices は将来 API が一覧を返すようになった場合の保険として残す
//! レスポンスは update.rs と同じく serde_json::Value の緩いパースで形の揺れに耐える。

use std::time::Duration;

use serde_json::{json, Value};

/// Polar の organization ID（本番。2026-08-16 設定済み）
pub(crate) const POLAR_ORG_ID: &str = "3251577f-3c8d-4062-b1b1-f0d5887f8f06";
/// 購入ページ（Polar のチェックアウトリンク。Monthly/Yearly 切替式。
/// 後日 Web の購入ページを作ったらその URL へ差し替える。
/// 変更時は system/os.rs の `url_allowed`（完全一致で許可）も自然に追従する）
pub(crate) const CHECKOUT_URL: &str =
    "https://buy.polar.sh/polar_cl_fF726ZLr5rvNa7e2B06u2TIVni6mFnnoPQfQf4CvZtp";

const POLAR_API: &str = "https://api.polar.sh/v1/customer-portal/license-keys";
const PLACEHOLDER_ORG: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Debug)]
pub(crate) enum PolarErr {
    /// サーバーが明示的に拒否（失効・解約・不正キー）。4xx
    Rejected(String),
    /// 到達できない / サーバー側の問題（ネット断・5xx・未設定）。ユーザーの落ち度ではない
    Unreachable(String),
}

pub(crate) struct Validation {
    /// validate レスポンスに含まれるアクティベーション一覧（取れた場合のみ）
    pub devices: Vec<Device>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub id: String,
    pub label: String,
    pub created_at: Option<String>,
}

pub(crate) struct Activation {
    pub id: String,
}

fn configured() -> bool {
    POLAR_ORG_ID != PLACEHOLDER_ORG
}

async fn post(path: &str, body: Value, app_version: &str) -> Result<Value, PolarErr> {
    if !configured() {
        return Err(PolarErr::Unreachable("polar not configured".into()));
    }
    let resp = reqwest::Client::new()
        .post(format!("{POLAR_API}/{path}"))
        .header("User-Agent", format!("PATerminal/{app_version}"))
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| PolarErr::Unreachable(e.to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| PolarErr::Unreachable(e.to_string()))?;
    if status.is_success() {
        // deactivate は 204 No Content（空ボディ）で成功を返す
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        return serde_json::from_str(&text).map_err(|e| PolarErr::Unreachable(e.to_string()));
    }
    let detail = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["detail"].as_str().map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}"));
    if status.is_client_error() {
        Err(PolarErr::Rejected(detail))
    } else {
        Err(PolarErr::Unreachable(detail))
    }
}

/// activate の Rejected がデバイス上限到達によるものか。
/// Polar の 403 detail は "License key activation limit already reached"（疎通確認済み）。
/// 同じ 403 でも "activation not supported"（benefit にアクティベーション設定が無い）は
/// 上限ではないので、"activation limit" を含むものだけを上限と判定する
pub(crate) fn is_activation_limit(msg: &str) -> bool {
    msg.to_ascii_lowercase().contains("activation limit")
}

pub(crate) fn parse_devices(v: &Value) -> Vec<Device> {
    let arr = v["activations"]
        .as_array()
        .or_else(|| v["license_key"]["activations"].as_array());
    let Some(arr) = arr else { return Vec::new() };
    arr.iter()
        .filter_map(|a| {
            Some(Device {
                id: a["id"].as_str()?.to_string(),
                label: a["label"].as_str().unwrap_or("(unnamed)").to_string(),
                created_at: a["created_at"].as_str().map(String::from),
            })
        })
        .collect()
}

/// キーの生死確認。validate が通る = サブスク有効。
pub(crate) async fn validate(
    key: &str,
    activation_id: Option<&str>,
    app_version: &str,
) -> Result<Validation, PolarErr> {
    let mut body = json!({ "key": key, "organization_id": POLAR_ORG_ID });
    if let Some(id) = activation_id {
        body["activation_id"] = json!(id);
    }
    let v = post("validate", body, app_version).await?;
    Ok(Validation {
        devices: parse_devices(&v),
    })
}

/// デバイス登録（1キー3台まで、上限は Polar 側の設定）。上限到達は Rejected で返る。
pub(crate) async fn activate(
    key: &str,
    label: &str,
    app_version: &str,
) -> Result<Activation, PolarErr> {
    let body = json!({ "key": key, "organization_id": POLAR_ORG_ID, "label": label });
    let v = post("activate", body, app_version).await?;
    let id = v["id"]
        .as_str()
        .or_else(|| v["activation"]["id"].as_str())
        .ok_or_else(|| PolarErr::Unreachable("no activation id in response".into()))?;
    Ok(Activation { id: id.to_string() })
}

/// デバイス解除。買い替え時に古い端末を外して続行できるようにする。
pub(crate) async fn deactivate(
    key: &str,
    activation_id: &str,
    app_version: &str,
) -> Result<(), PolarErr> {
    let body = json!({ "key": key, "organization_id": POLAR_ORG_ID, "activation_id": activation_id });
    post("deactivate", body, app_version).await.map(|_| ())
}

/// アクティベーションのラベル。個人情報を避け、OS 名 + 日付だけにする
pub(crate) fn device_label() -> String {
    let os = if cfg!(target_os = "macos") {
        "macOS"
    } else if cfg!(windows) {
        "Windows"
    } else {
        "Linux"
    };
    // 日付は「どれが古い端末か」を見分けるためだけの粒度でよい
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86400)
        .unwrap_or(0);
    format!("{os} (day {days})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_devices_reads_both_shapes() {
        let flat = serde_json::json!({
            "activations": [
                { "id": "a1", "label": "macOS (day 1)", "created_at": "2026-08-01T00:00:00Z" },
                { "id": "a2" }
            ]
        });
        let d = parse_devices(&flat);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].id, "a1");
        assert_eq!(d[1].label, "(unnamed)");

        let nested = serde_json::json!({ "license_key": { "activations": [{ "id": "b1", "label": "x" }] } });
        assert_eq!(parse_devices(&nested)[0].id, "b1");

        assert!(parse_devices(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn activation_limit_detected_from_polar_detail() {
        // sandbox 疎通確認で得た実メッセージ
        assert!(is_activation_limit(
            "License key activation limit already reached"
        ));
        // 同じ 403 でも「アクティベーション非対応」は上限ではない
        assert!(!is_activation_limit("License key activation not supported"));
        assert!(!is_activation_limit("License key not found."));
    }

    #[test]
    fn device_label_has_no_personal_info() {
        let l = device_label();
        assert!(l.starts_with("macOS") || l.starts_with("Windows") || l.starts_with("Linux"));
    }
}
