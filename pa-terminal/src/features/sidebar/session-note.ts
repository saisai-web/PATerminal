import { t } from "../../i18n";
import { normalizeWorkspaceNote, WORKSPACE_NOTE_MAX_LENGTH } from "../../workspace/note";
import { isLocked, lockClass, requireFeature } from "../license/license";

// ============================================================
// セッションの一言メモ欄（1行表示 + クリックで開く編集ポップオーバー）
// ============================================================

let notePopoverEl: HTMLDivElement | null = null;
let notePopoverOwner: HTMLButtonElement | null = null;
let notePopoverCommit: (() => void) | null = null;
let notePopoverDiscard: (() => void) | null = null;

/** discard=true は Escape（編集を取り消して閉じる）。それ以外の閉じ方は確定する */
function closeNotePopover(discard = false) {
  if (!notePopoverEl) return;
  const commit = notePopoverCommit;
  const restore = notePopoverDiscard;
  notePopoverEl.remove();
  notePopoverEl = null;
  notePopoverOwner = null;
  notePopoverCommit = null;
  notePopoverDiscard = null;
  if (discard) restore?.();
  else commit?.();
}

// 右クリックメニューと同じ流儀の閉じ方（外側クリック / Escape / blur / resize）。
// 開いたメモ欄自身の mousedown は除外し、欄側のトグル（保存して閉じる）に任せる
window.addEventListener(
  "mousedown",
  (e) => {
    if (!notePopoverEl) return;
    const target = e.target as Node;
    if (notePopoverEl.contains(target)) return;
    if (notePopoverOwner?.contains(target)) return;
    closeNotePopover();
  },
  true,
);
window.addEventListener(
  "keydown",
  (e) => {
    if (notePopoverEl && e.key === "Escape" && !e.isComposing) {
      e.stopPropagation();
      closeNotePopover(true);
    }
  },
  true,
);
window.addEventListener("blur", () => closeNotePopover());
window.addEventListener("resize", () => closeNotePopover());

/**
 * セッション項目に常設する一言メモ欄を作る。
 * 欄自体は1行のボタン表示（長文は … で省略・全文は title）で、クリックすると
 * 欄の直下に編集ポップオーバー（セッション名 + textarea + ヒント / 文字数）を開く。
 * Enter・外側クリック・blur = 保存して閉じる / Escape = 取り消して閉じる。
 * 編集中の内容は欄へライブ反映し、確定値だけを commit へ渡す。
 * onItemClick は欄の mousedown を「セッション項目のクリック」として扱うかの判定。
 * true を返したら編集は開かない（欄が項目の中央を広く覆うため、丸ごと飲み込むと
 * 項目クリックでセッションを切り替えられなくなる。実バグの前例あり）。
 */
export function createSessionNoteField(
  wsName: string,
  current: string | undefined,
  commit: (value: string) => void,
  onItemClick: (event: MouseEvent) => boolean,
): HTMLDivElement {
  const field = document.createElement("div");
  field.className = "ws-note-field";
  lockClass(field);

  const display = document.createElement("button");
  display.type = "button";
  display.className = "ws-note-display";
  display.setAttribute("aria-label", t("ws.noteViewTitle"));
  display.setAttribute("aria-haspopup", "dialog");

  let committed = normalizeWorkspaceNote(current) ?? "";
  const setDisplay = (value: string) => {
    const empty = !value;
    display.classList.toggle("is-empty", empty);
    display.textContent = empty ? t("ws.notePlaceholder") : value;
    display.title = empty ? t("ws.noteViewTitle") : value; // 省略時も全文を読めるように
  };
  setDisplay(committed);

  const save = (value: string) => {
    const v = normalizeWorkspaceNote(value) ?? "";
    setDisplay(v);
    if (v === committed) return;
    committed = v;
    // 空文字は updateWorkspaceNote 側で undefined として保存される
    commit(v);
  };

  const openEditor = () => {
    closeNotePopover(); // 別の欄のポップオーバーは確定して閉じる
    const pop = document.createElement("div");
    pop.className = "ws-note-popover";
    const name = document.createElement("div");
    name.className = "ws-note-popover-name";
    name.textContent = wsName;
    const ta = document.createElement("textarea");
    ta.className = "ws-note-popover-input";
    ta.maxLength = WORKSPACE_NOTE_MAX_LENGTH;
    ta.placeholder = t("ws.notePlaceholder");
    ta.setAttribute("aria-label", t("ws.noteViewTitle"));
    ta.value = committed;
    const foot = document.createElement("div");
    foot.className = "ws-note-popover-foot";
    const hint = document.createElement("span");
    hint.textContent = t("ws.noteEditHint");
    const count = document.createElement("span");
    count.className = "ws-note-popover-count";
    const syncCount = () => {
      count.textContent = `${ta.value.length}/${WORKSPACE_NOTE_MAX_LENGTH}`;
    };
    syncCount();
    foot.append(hint, count);

    ta.addEventListener("input", () => {
      setDisplay(ta.value); // 確定は閉じるとき。欄にはライブで映す
      syncCount();
    });
    ta.addEventListener("keydown", (event) => {
      event.stopPropagation(); // グローバルショートカットへ流さない（Escape は window 側で拾う）
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        closeNotePopover(); // 保存して閉じる
      }
    });
    // ポップオーバー内のクリックを項目クリックへ流さない
    for (const type of ["click", "dblclick"] as const) {
      pop.addEventListener(type, (event) => event.stopPropagation());
    }
    // 書き込みはソフトロックの対象（表示は常時可）
    ta.addEventListener("pointerdown", (event) => {
      if (requireFeature()) return;
      event.preventDefault();
      ta.blur();
    });
    ta.addEventListener("focus", () => {
      if (!requireFeature()) ta.blur();
    });

    pop.append(name, ta, foot);
    document.body.append(pop);
    notePopoverEl = pop;
    notePopoverOwner = display;
    notePopoverCommit = () => save(ta.value);
    notePopoverDiscard = () => setDisplay(committed);
    // 欄の直下に、欄と同じ幅感で開く（狭いサイドバーでは最低幅を確保）
    const rect = field.getBoundingClientRect();
    pop.style.width = `${Math.min(320, Math.max(240, Math.round(rect.width)))}px`;
    pop.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(0, Math.min(rect.bottom + 4, window.innerHeight - pop.offsetHeight - 8))}px`;
    // ロック中に自動フォーカスすると閲覧のつもりでも購入モーダルが開いてしまう
    if (!isLocked()) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  };

  // 開閉・項目クリックへの振り分けは mousedown で確定する（クリック中にサイドバーが
  // 再描画されると click イベントの届き先が不安定になるため、click には依存しない）。
  // 非アクティブ項目・修飾キー付きは項目クリック（切替・選択）、アクティブ項目の
  // 素クリックだけが編集ポップオーバーを開く。開いている欄の再クリックは保存して閉じる
  display.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (notePopoverOwner === display) {
      closeNotePopover();
      return;
    }
    if (onItemClick(event)) {
      event.preventDefault();
      return;
    }
    // 既定動作の「押したボタンへフォーカス」が textarea の autofocus を上書きするので止める
    event.preventDefault();
    openEditor();
  });
  display.addEventListener("click", (event) => {
    event.stopPropagation();
    // キーボード操作（Enter / Space）による click は detail=0。mousedown を通らないのでここで開く
    if (event.detail === 0 && notePopoverOwner !== display) openEditor();
  });
  display.addEventListener("dblclick", (event) => event.stopPropagation());

  field.append(display);
  return field;
}
