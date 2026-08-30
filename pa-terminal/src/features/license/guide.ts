// ============================================================
// 初回ガイド（#guide-panel、右下の非モーダルパネル）。
// 公式ビルドのトライアル中に一度だけ、主要機能（並列ペイン・ペアモード・Git 管制・
// 会話引き継ぎ）へ気づかせるチェックリストを出す。× で license_guide_dismiss →
// 二度と自動表示しない。常時表示・モーダル連発は禁止（指示書 §トライアルの実装要件）。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { getLicense } from "./license";

const panelEl = document.getElementById("guide-panel") as HTMLDivElement;
const closeBtn = document.getElementById("guide-close") as HTMLButtonElement;

function dismiss() {
  panelEl.hidden = true;
  void invoke("license_guide_dismiss").catch(() => {});
}

/** 行クリックで該当機能の入口を押す（ロック中なら購入案内が出るのも織り込み済み） */
function wireRow(rowId: string, targetId: string) {
  const row = document.getElementById(rowId) as HTMLButtonElement | null;
  if (!row) return;
  row.onclick = () => {
    document.getElementById(targetId)?.dispatchEvent(new MouseEvent("click"));
  };
}

export function initGuide() {
  closeBtn.onclick = dismiss;
  wireRow("guide-panes", "split-right");
  wireRow("guide-pair", "pair-open");
  wireRow("guide-git", "explorer-toggle");
  wireRow("guide-takeover", "takeover-open");
  // ガイドは boot 直後の状態でのみ判定（起動中に出したり消したりしない）
  if (getLicense().guidePending) panelEl.hidden = false;
}
