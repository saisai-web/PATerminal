// ============================================================
// 右クリックメニュー共通アクション（サイドバーのセッションメニューから使う）
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { getHostOs } from "../../workspace/state";

/** 「Finder で表示」のラベル。OS のファイルマネージャー名に合わせる */
export function revealLabel(): string {
  if (getHostOs() === "macos") return t("ctx.revealMac");
  if (getHostOs() === "windows") return t("ctx.revealWin");
  return t("ctx.revealOther");
}

/** OS のファイルマネージャーでパスを表示（ファイルは選択状態で親フォルダを開く） */
export function revealInOs(path: string) {
  void invoke("reveal_path", { path }).catch((e) => console.error("reveal_path failed:", e));
}
