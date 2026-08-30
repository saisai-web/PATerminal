//! ライセンス状態の判定。すべて純粋関数（I/O 無し）にしてテスト可能にする。
//! official は cfg! ではなく bool 引数で受ける（デフォルト features の cargo test で
//! 公式ビルドのロジックも全部テストするため）。

use super::key::{KeyInfo, KeyKind};
use super::store::LicenseStore;

pub(crate) const DAY: u64 = 86400;
pub(crate) const TRIAL_DAYS: u64 = 30;
pub(crate) const GRACE_DAYS: u64 = 30;
pub(crate) const REVALIDATE_DAYS: u64 = 7;
pub(crate) const RETRIAL_DAYS: u64 = 7;
pub(crate) const WINBACK_AFTER_DAYS: u64 = 30;

#[derive(Debug, PartialEq)]
pub(crate) enum Computed {
    Selfbuild,
    Trial { days_left: u32 },
    Retrial { days_left: u32 },
    Licensed,
    Grace { days_left: u32 },
    Locked { retrial_available: bool },
}

/// 時計巻き戻しの最小対策: 最後に見た時刻より過去なら経過扱い
pub(crate) fn effective_now(now: u64, last_seen: u64) -> u64 {
    now.max(last_seen)
}

/// 期限 `until` までの残り日数（切り上げ。当日=1）。過ぎていれば None
fn days_left(now: u64, until: u64) -> Option<u32> {
    if now >= until {
        return None;
    }
    Some(((until - now).div_ceil(DAY)) as u32)
}

/// paid キーの7日ごとのオンライン再検証が必要か
pub(crate) fn revalidation_due(now: u64, last_ok: Option<u64>) -> bool {
    match last_ok {
        Some(ok) => now.saturating_sub(ok) > REVALIDATE_DAYS * DAY,
        None => true,
    }
}

/// 現在の状態を導出する。`key` は署名・期限・失効の検証を通った KeyInfo のみ渡す
/// （無効キーは None として渡す = キー無し扱い）。
pub(crate) fn compute(official: bool, now: u64, store: &LicenseStore, key: Option<&KeyInfo>) -> Computed {
    if !official {
        return Computed::Selfbuild;
    }
    if let Some(key) = key {
        match key.kind {
            // dev は署名 + 期限のみ（Polar 照会しない）。ここに来た時点で有効
            KeyKind::Dev => return Computed::Licensed,
            KeyKind::Paid => {
                // Grace の起点は「最後に検証が成功した時刻」。登録直後は
                // license_activate が last_validation_ok を刻むので None にはならないが、
                // 万一 None なら登録時刻情報が無い = 猶予を与えて Grace 扱いにはできず、
                // ユーザー有利に倒して Licensed（次回のバックグラウンド検証で確定する）
                let Some(ok) = store.last_validation_ok else {
                    return Computed::Licensed;
                };
                let since = now.saturating_sub(ok);
                if since <= REVALIDATE_DAYS * DAY {
                    return Computed::Licensed;
                }
                if let Some(d) = days_left(now, ok + GRACE_DAYS * DAY) {
                    return Computed::Grace { days_left: d };
                }
                // 猶予切れ → Locked へ（下のトライアル判定は通さない。
                // キー保持者が Trial 残で戻る動線は「キー解除」で明示的に行う）
                return Computed::Locked {
                    retrial_available: retrial_available(now, store),
                };
            }
        }
    }
    if let Some(start) = store.trial_start {
        if let Some(d) = days_left(now, start + TRIAL_DAYS * DAY) {
            return Computed::Trial { days_left: d };
        }
    }
    if let Some(start) = store.retrial_start {
        if let Some(d) = days_left(now, start + RETRIAL_DAYS * DAY) {
            return Computed::Retrial { days_left: d };
        }
    }
    Computed::Locked {
        retrial_available: retrial_available(now, store),
    }
}

/// Win-back: Locked が30日継続 + 未使用のときだけ一度きり
fn retrial_available(now: u64, store: &LicenseStore) -> bool {
    if store.retrial_used {
        return false;
    }
    match store.locked_since {
        Some(t) => now.saturating_sub(t) >= WINBACK_AFTER_DAYS * DAY,
        None => false,
    }
}

/// 未表示のトライアル残バナー ID を返す（残り7/3/1日に一度ずつ + Locked 初回）。
/// 表示済み管理は banners_shown（license_banner_seen で既読化）。
pub(crate) fn pending_banner(c: &Computed, shown: &[String]) -> Option<&'static str> {
    let id = match c {
        Computed::Trial { days_left } | Computed::Retrial { days_left } => match days_left {
            0..=1 => "trial1",
            2..=3 => "trial3",
            4..=7 => "trial7",
            _ => return None,
        },
        Computed::Locked { .. } => "lockedOnce",
        _ => return None,
    };
    if shown.iter().any(|s| s == id) {
        return None;
    }
    Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::license::key::{KeyInfo, KeyKind};

    fn paid_key() -> KeyInfo {
        KeyInfo {
            id: "K-1".into(),
            kind: KeyKind::Paid,
            exp: None,
            polar_key: Some("PAT-x".into()),
        }
    }

    fn dev_key() -> KeyInfo {
        KeyInfo {
            id: "K-D".into(),
            kind: KeyKind::Dev,
            exp: Some(u64::MAX),
            polar_key: None,
        }
    }

    fn store() -> LicenseStore {
        LicenseStore::default()
    }

    #[test]
    fn selfbuild_never_locks() {
        let mut s = store();
        s.trial_start = Some(0);
        assert_eq!(compute(false, DAY * 400, &s, None), Computed::Selfbuild);
    }

    #[test]
    fn trial_days_left_counts_down() {
        let mut s = store();
        s.trial_start = Some(0);
        assert_eq!(compute(true, 0, &s, None), Computed::Trial { days_left: 30 });
        assert_eq!(
            compute(true, DAY * 23, &s, None),
            Computed::Trial { days_left: 7 }
        );
        assert_eq!(
            compute(true, DAY * 30 - 1, &s, None),
            Computed::Trial { days_left: 1 }
        );
    }

    #[test]
    fn trial_expires_straight_to_locked_without_grace() {
        let mut s = store();
        s.trial_start = Some(0);
        assert_eq!(
            compute(true, DAY * 30, &s, None),
            Computed::Locked {
                retrial_available: false
            }
        );
    }

    #[test]
    fn no_trial_record_is_locked() {
        assert_eq!(
            compute(true, 1000, &store(), None),
            Computed::Locked {
                retrial_available: false
            }
        );
    }

    #[test]
    fn dev_key_is_licensed_without_polar() {
        let s = store();
        assert_eq!(compute(true, 1000, &s, Some(&dev_key())), Computed::Licensed);
    }

    #[test]
    fn paid_key_licensed_within_seven_days() {
        let mut s = store();
        s.last_validation_ok = Some(0);
        assert_eq!(
            compute(true, DAY * 7, &s, Some(&paid_key())),
            Computed::Licensed
        );
    }

    #[test]
    fn paid_key_grace_after_seven_days_then_locked_after_thirty() {
        let mut s = store();
        s.last_validation_ok = Some(0);
        assert_eq!(
            compute(true, DAY * 8, &s, Some(&paid_key())),
            Computed::Grace { days_left: 22 }
        );
        assert_eq!(
            compute(true, DAY * 30, &s, Some(&paid_key())),
            Computed::Locked {
                retrial_available: false
            }
        );
    }

    #[test]
    fn paid_key_recovers_to_licensed_after_validation() {
        let mut s = store();
        s.last_validation_ok = Some(DAY * 20); // Grace 中に検証成功した想定
        assert_eq!(
            compute(true, DAY * 21, &s, Some(&paid_key())),
            Computed::Licensed
        );
    }

    #[test]
    fn key_overrides_remaining_trial() {
        let mut s = store();
        s.trial_start = Some(0);
        s.last_validation_ok = Some(0);
        assert_eq!(compute(true, DAY, &s, Some(&paid_key())), Computed::Licensed);
    }

    #[test]
    fn effective_now_resists_clock_rollback() {
        assert_eq!(effective_now(500, 1000), 1000);
        assert_eq!(effective_now(1500, 1000), 1500);
    }

    #[test]
    fn retrial_available_after_thirty_locked_days_once() {
        let mut s = store();
        s.locked_since = Some(0);
        assert_eq!(
            compute(true, DAY * 30, &s, None),
            Computed::Locked {
                retrial_available: true
            }
        );
        s.retrial_used = true;
        assert_eq!(
            compute(true, DAY * 30, &s, None),
            Computed::Locked {
                retrial_available: false
            }
        );
    }

    #[test]
    fn retrial_runs_seven_days_then_locks() {
        let mut s = store();
        s.retrial_used = true;
        s.retrial_start = Some(DAY * 100);
        assert_eq!(
            compute(true, DAY * 100, &s, None),
            Computed::Retrial { days_left: 7 }
        );
        assert_eq!(
            compute(true, DAY * 107, &s, None),
            Computed::Locked {
                retrial_available: false
            }
        );
    }

    #[test]
    fn revalidation_due_after_seven_days() {
        assert!(revalidation_due(DAY * 8, Some(0)));
        assert!(!revalidation_due(DAY * 6, Some(0)));
        assert!(revalidation_due(0, None));
    }

    #[test]
    fn banners_fire_once_per_threshold() {
        let trial = |d| Computed::Trial { days_left: d };
        assert_eq!(pending_banner(&trial(7), &[]), Some("trial7"));
        assert_eq!(pending_banner(&trial(8), &[]), None);
        assert_eq!(pending_banner(&trial(3), &[]), Some("trial3"));
        assert_eq!(pending_banner(&trial(1), &[]), Some("trial1"));
        assert_eq!(pending_banner(&trial(7), &["trial7".into()]), None);
        let locked = Computed::Locked {
            retrial_available: false,
        };
        assert_eq!(pending_banner(&locked, &[]), Some("lockedOnce"));
        assert_eq!(pending_banner(&locked, &["lockedOnce".into()]), None);
        assert_eq!(pending_banner(&Computed::Licensed, &[]), None);
    }
}
