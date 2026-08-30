// ============================================================
// 右クリックメニューの生成・配置（サイドバー / エクスプローラー共用）
// ============================================================

let ctxMenuEl: HTMLDivElement | null = null;

/** 表示中のメニュー要素（外側クリック / Escape の判定に使う） */
export function getCtxMenuEl(): HTMLDivElement | null {
  return ctxMenuEl;
}

export function closeGroupMenu() {
  ctxMenuEl?.remove();
  ctxMenuEl = null;
}

/** メニューを表示して画面内にクランプする（各右クリックメニュー共通の後処理） */
export function showCtxMenu(menu: HTMLDivElement, x: number, y: number) {
  document.body.append(menu);
  ctxMenuEl = menu;
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
}
