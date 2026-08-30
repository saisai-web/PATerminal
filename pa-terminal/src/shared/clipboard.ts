/** クリップボードへコピー。WKWebView で Clipboard API が拒否される環境では
    一時 textarea + execCommand にフォールバックする */
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* フォールバックへ */
  }
  const prev = document.activeElement;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    ta.remove();
    if (prev instanceof HTMLElement) prev.focus(); // 元の操作対象からフォーカスを奪ったままにしない
  }
}
