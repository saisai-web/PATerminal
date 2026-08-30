// ============================================================
// インライン編集（セッション名 / ペイン名 / グループ名）
// ============================================================

/** テキスト要素をその場で input に差し替えて編集する。Enter 確定 / Esc キャンセル。
    空文字（と前後空白のみ）はキャンセル扱い。編集中の打鍵は stopPropagation で
    ターミナルやアプリのショートカットに流さない。 */
export function startInlineEdit(host: HTMLElement, current: string, commit: (v: string) => void) {
  if (host.querySelector(".inline-edit")) return;
  const prev = host.textContent ?? "";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-edit";
  input.value = current;
  host.textContent = "";
  host.append(input);
  let done = false;
  const finish = (ok: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove();
    if (ok && v) {
      host.textContent = v;
      if (v !== current) commit(v);
    } else {
      host.textContent = prev; // 空文字は確定不可（キャンセル扱い）
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // ショートカット（分割・切替等）に吸わせない
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  // クリックが親（セッション切替・グループ開閉）に伝わって編集が壊れるのを防ぐ
  for (const t of ["mousedown", "click", "dblclick"] as const) {
    input.addEventListener(t, (e) => e.stopPropagation());
  }
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
}
