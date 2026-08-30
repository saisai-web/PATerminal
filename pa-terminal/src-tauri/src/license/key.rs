//! ライセンスキーのパースとオフライン署名検証。ネット無しでも真正性を確認できる。
//!
//! 受理する形式は2つ:
//! 1. 署名形式 `PATERM1.<base64url(payload JSON)>.<base64url(署名64byte)>`
//!    payload = `{"v":1,"id":"K-...","kind":"paid"|"dev","exp":unix秒|null,"polar":"PAT-..."|null}`
//!    dev キーは exp 必須（Polar 照会をしない代わりに短期運用）。
//!    keygen / issue-key スクリプトは公開リポジトリに置かない（秘密鍵と同じ場所で保管）
//! 2. Polar 生キー（`PAT-` プレフィックス）: Polar が自動発行するキーには自前署名を
//!    載せられないため、kind=paid・キーID=キー文字列として受理し、真正性は Polar 照会
//!    （+ Grace 30日の実績ベース）で担保する
//!
//! 失効リスト（REVOKED_KEY_IDS）は種別を問わず照合する。通常は空で、dev キー漏洩などの
//! 非常時にだけアップデートで配布する。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};

/// アプリ内蔵の検証用公開鍵（base64 標準形・32byte）。~/.paterminal-keys/keygen.mjs の
/// 出力を貼る。秘密鍵は絶対にリポジトリへ入れない（docs/key-management.md）
pub(crate) const PUBLIC_KEY_B64: &str = "QxXTCRrfZLUO/gamClW/WTUcIpKKhP3eKY90/hIUYRo=";

/// 失効させたキー ID。通常は空。追記したらリリースで配布する
pub(crate) const REVOKED_KEY_IDS: &[&str] = &[];

/// Polar 生キーのプレフィックス（Polar 側のキー設定と合わせる。docs/polar-setup.md）
const POLAR_KEY_PREFIX: &str = "PAT-";

const SIGNED_PREFIX: &str = "PATERM1.";

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum KeyKind {
    Paid,
    Dev,
}

#[derive(Clone, Debug)]
pub(crate) struct KeyInfo {
    pub id: String,
    pub kind: KeyKind,
    /// 有効期限（unix 秒）。dev は必須、paid は任意（Polar 照会が生死を決める）
    pub exp: Option<u64>,
    /// Polar 照会に使うキー。生キーは自身、署名付き paid は payload の polar フィールド
    pub polar_key: Option<String>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum KeyError {
    Malformed,
    BadSignature,
    Expired,
    Revoked,
}

impl KeyError {
    pub(crate) fn message(&self) -> &'static str {
        match self {
            KeyError::Malformed => "malformed",
            KeyError::BadSignature => "bad-signature",
            KeyError::Expired => "expired",
            KeyError::Revoked => "revoked",
        }
    }
}

pub(crate) fn embedded_public_key() -> Option<VerifyingKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(PUBLIC_KEY_B64)
        .ok()?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    VerifyingKey::from_bytes(&arr).ok()
}

/// キーのパース + 署名検証 + 期限 + 失効リスト照合。
/// `pubkey` を引数で受けるのはテストで固定シードの鍵ペアを使うため。
pub(crate) fn parse_and_verify(
    raw: &str,
    pubkey: &VerifyingKey,
    now: u64,
) -> Result<KeyInfo, KeyError> {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix(SIGNED_PREFIX) {
        return verify_signed(rest, pubkey, now);
    }
    if raw.starts_with(POLAR_KEY_PREFIX) && raw.len() >= 8 && is_plausible_polar_key(raw) {
        if REVOKED_KEY_IDS.contains(&raw) {
            return Err(KeyError::Revoked);
        }
        return Ok(KeyInfo {
            id: raw.to_string(),
            kind: KeyKind::Paid,
            exp: None,
            polar_key: Some(raw.to_string()),
        });
    }
    Err(KeyError::Malformed)
}

/// Polar 生キーとして通す文字集合（英数字とハイフンのみ。シェルや JSON に安全）
fn is_plausible_polar_key(raw: &str) -> bool {
    raw.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn verify_signed(rest: &str, pubkey: &VerifyingKey, now: u64) -> Result<KeyInfo, KeyError> {
    let (payload_b64, sig_b64) = rest.split_once('.').ok_or(KeyError::Malformed)?;
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| KeyError::Malformed)?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| KeyError::Malformed)?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().map_err(|_| KeyError::Malformed)?;
    let sig = Signature::from_bytes(&sig_arr);
    pubkey
        .verify_strict(&payload, &sig)
        .map_err(|_| KeyError::BadSignature)?;

    let v: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| KeyError::Malformed)?;
    let id = v["id"].as_str().ok_or(KeyError::Malformed)?.to_string();
    let kind = match v["kind"].as_str() {
        Some("paid") => KeyKind::Paid,
        Some("dev") => KeyKind::Dev,
        _ => return Err(KeyError::Malformed),
    };
    let info = KeyInfo {
        id,
        kind,
        exp: v["exp"].as_u64(),
        polar_key: v["polar"].as_str().map(String::from),
    };
    // dev キーはオンライン失効ができないので有効期限を必須にする
    if info.kind == KeyKind::Dev && info.exp.is_none() {
        return Err(KeyError::Malformed);
    }
    if REVOKED_KEY_IDS.contains(&info.id.as_str()) {
        return Err(KeyError::Revoked);
    }
    if let Some(exp) = info.exp {
        if now > exp {
            return Err(KeyError::Expired);
        }
    }
    Ok(info)
}

/// 設定画面表示用のマスク（末尾数文字だけ見せる）
pub(crate) fn masked(raw: &str) -> String {
    let raw = raw.trim();
    let tail: String = raw
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};

    fn test_keys() -> (SigningKey, VerifyingKey) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk = sk.verifying_key();
        (sk, vk)
    }

    fn make_key(sk: &SigningKey, payload: &str) -> String {
        let sig = sk.sign(payload.as_bytes());
        format!(
            "PATERM1.{}.{}",
            URL_SAFE_NO_PAD.encode(payload.as_bytes()),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        )
    }

    #[test]
    fn valid_paid_key_verifies() {
        let (sk, vk) = test_keys();
        let key = make_key(
            &sk,
            r#"{"v":1,"id":"K-1","kind":"paid","exp":null,"polar":"PAT-abc"}"#,
        );
        let info = parse_and_verify(&key, &vk, 1000).unwrap();
        assert_eq!(info.id, "K-1");
        assert_eq!(info.kind, KeyKind::Paid);
        assert_eq!(info.polar_key.as_deref(), Some("PAT-abc"));
    }

    #[test]
    fn valid_dev_key_requires_exp() {
        let (sk, vk) = test_keys();
        let with_exp = make_key(&sk, r#"{"v":1,"id":"K-D","kind":"dev","exp":2000}"#);
        assert!(parse_and_verify(&with_exp, &vk, 1000).is_ok());
        let without = make_key(&sk, r#"{"v":1,"id":"K-D","kind":"dev"}"#);
        assert_eq!(
            parse_and_verify(&without, &vk, 1000).unwrap_err(),
            KeyError::Malformed
        );
    }

    #[test]
    fn expired_dev_key_rejected() {
        let (sk, vk) = test_keys();
        let key = make_key(&sk, r#"{"v":1,"id":"K-D","kind":"dev","exp":500}"#);
        assert_eq!(
            parse_and_verify(&key, &vk, 1000).unwrap_err(),
            KeyError::Expired
        );
    }

    #[test]
    fn tampered_payload_rejected() {
        let (sk, vk) = test_keys();
        let key = make_key(&sk, r#"{"v":1,"id":"K-1","kind":"paid"}"#);
        // payload 部を差し替え（署名は元のまま）
        let parts: Vec<&str> = key.splitn(3, '.').collect();
        let forged_payload = URL_SAFE_NO_PAD.encode(br#"{"v":1,"id":"K-2","kind":"paid"}"#);
        let forged = format!("PATERM1.{}.{}", forged_payload, parts[2]);
        assert_eq!(
            parse_and_verify(&forged, &vk, 1000).unwrap_err(),
            KeyError::BadSignature
        );
    }

    #[test]
    fn tampered_signature_rejected() {
        let (sk, vk) = test_keys();
        let key = make_key(&sk, r#"{"v":1,"id":"K-1","kind":"paid"}"#);
        let mut forged = key.clone();
        // 署名部の末尾1文字を入れ替える
        let last = forged.pop().unwrap();
        forged.push(if last == 'A' { 'B' } else { 'A' });
        let err = parse_and_verify(&forged, &vk, 1000).unwrap_err();
        assert!(matches!(err, KeyError::BadSignature | KeyError::Malformed));
    }

    #[test]
    fn wrong_pubkey_rejected() {
        let (sk, _) = test_keys();
        let other_vk = SigningKey::from_bytes(&[9u8; 32]).verifying_key();
        let key = make_key(&sk, r#"{"v":1,"id":"K-1","kind":"paid"}"#);
        assert_eq!(
            parse_and_verify(&key, &other_vk, 1000).unwrap_err(),
            KeyError::BadSignature
        );
    }

    #[test]
    fn malformed_keys_rejected() {
        let (_, vk) = test_keys();
        for raw in ["", "hello", "PATERM1.", "PATERM1.abc", "PAT", "PAT-a b"] {
            assert_eq!(
                parse_and_verify(raw, &vk, 1000).unwrap_err(),
                KeyError::Malformed,
                "{raw}"
            );
        }
    }

    #[test]
    fn raw_polar_key_accepted_as_paid() {
        let (_, vk) = test_keys();
        let info = parse_and_verify("PAT-1234-ABCD", &vk, 1000).unwrap();
        assert_eq!(info.kind, KeyKind::Paid);
        assert_eq!(info.id, "PAT-1234-ABCD");
        assert_eq!(info.polar_key.as_deref(), Some("PAT-1234-ABCD"));
        assert_eq!(info.exp, None);
    }

    #[test]
    fn embedded_public_key_parses() {
        // プレースホルダ/本番いずれでも、埋め込み値は必ず32byteの正しい形であること
        assert!(embedded_public_key().is_some());
    }

    #[test]
    fn masked_shows_only_tail() {
        assert_eq!(masked("PAT-1234-ABCD"), "…ABCD");
        assert_eq!(masked("abc"), "…abc");
    }
}
