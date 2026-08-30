// ============================================================
// 自ビルド系統だけの新バージョン通知（引力のみ・嫌がらせ禁止）。
// GitHub Releases の公開 API を1日1回まで確認し（1日1回の消化と設定オフは
// Rust 側 license_update_notify が管理）、新しければ控えめなバナーを出す。
// 識別子・トラッキングは一切送らない（update_check は UA にバージョンを載せるだけ）。
// 公式ビルドは自動更新があるため何もしない。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { isNewerVersion } from "../settings/settings-panel";
import { showUpdateBanner } from "./banner";
import { getLicense } from "./license";

type UpdateInfo = { current: string; latest: string | null; url: string | null };

export function initSelfBuildNotify() {
  if (getLicense().official) return;
  void (async () => {
    try {
      const info = await invoke<{ off: boolean; due: boolean }>("license_update_notify", {
        off: null,
      });
      if (info.off || !info.due) return;
      const u = await invoke<UpdateInfo>("update_check");
      if (u.latest && isNewerVersion(u.latest, u.current)) showUpdateBanner(u.latest);
    } catch {
      /* ネットに出られない・API 失敗は静かに何もしない */
    }
  })();
}
