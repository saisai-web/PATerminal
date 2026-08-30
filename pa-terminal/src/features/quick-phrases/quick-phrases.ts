import { t } from "../../i18n";
import { isLocked, onLicenseChange, requireFeature } from "../license/license";
import { trackSelectionDrag } from "../../shared/selection-drag";

type QuickPhraseOptions = {
  insert: (text: string) => boolean;
  onChange: () => void;
  /** 定型文バーの表示/非表示・開閉が変わったときの再レイアウト（グリッドの高さが変わり refit が要る） */
  layout: () => void;
  /** 選択モードを抜けるときにターミナルへフォーカスを返す */
  focusTerminal: () => void;
};

/** 保存単位。`repo` はリポジトリルートの絶対パスで、無いものは汎用（どこでも出る）。 */
export type QuickPhrase = { text: string; repo?: string };

const openBtn = document.querySelector<HTMLButtonElement>("#quick-phrases-open")!;
const barEl = document.querySelector<HTMLDivElement>("#quick-phrase-bar")!;
const barHeadEl = document.querySelector<HTMLDivElement>("#quick-phrase-bar-head")!;
const barCollapseBtn = document.querySelector<HTMLButtonElement>("#quick-phrase-collapse")!;
const barContentEl = document.querySelector<HTMLDivElement>("#quick-phrase-bar-content")!;
const barSummaryEl = document.querySelector<HTMLSpanElement>("#quick-phrase-bar-summary")!;
const barTitleBtn = document.querySelector<HTMLButtonElement>("#quick-phrase-bar-title")!;
const barScrollEl = document.querySelector<HTMLDivElement>("#quick-phrase-scroll")!;
const barListEl = document.querySelector<HTMLDivElement>("#quick-phrase-bar-list")!;
const barScrollbarEl = document.querySelector<HTMLDivElement>("#quick-phrase-scrollbar")!;
const barScrollThumbEl = document.querySelector<HTMLDivElement>("#quick-phrase-scroll-thumb")!;
const barHintEl = document.querySelector<HTMLSpanElement>("#quick-phrase-bar-hint")!;
const overlay = document.querySelector<HTMLDivElement>("#quick-phrases-overlay")!;
const panel = document.querySelector<HTMLDivElement>("#quick-phrases-panel")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#quick-phrases-close")!;
const hintEl = document.querySelector<HTMLParagraphElement>("#quick-phrases-hint")!;
const listEl = document.querySelector<HTMLDivElement>("#quick-phrases-list")!;
const emptyEl = document.querySelector<HTMLDivElement>("#quick-phrases-empty")!;
const form = document.querySelector<HTMLFormElement>("#quick-phrases-form")!;
const input = document.querySelector<HTMLInputElement>("#quick-phrase-input")!;
const cancelBtn = document.querySelector<HTMLButtonElement>("#quick-phrase-cancel")!;
const submitBtn = document.querySelector<HTMLButtonElement>("#quick-phrase-submit")!;
const scopeTitleEl = document.querySelector<HTMLSpanElement>("#quick-phrase-scope-title")!;
const scopeGlobalRadio = document.querySelector<HTMLInputElement>("#quick-phrase-scope-global")!;
const scopeGlobalLabel = document.querySelector<HTMLSpanElement>("#quick-phrase-scope-global-label")!;
const scopeRepoRadio = document.querySelector<HTMLInputElement>("#quick-phrase-scope-repo")!;
const scopeRepoLabel = document.querySelector<HTMLSpanElement>("#quick-phrase-scope-repo-label")!;

let phrases: QuickPhrase[] = [];
/** いま監視中のリポジトリルート（変更ストリップの git 監視から流し込まれる） */
let currentRepo: string | null = null;
let editingIndex: number | null = null;
/** 編集中の項目が属するリポジトリ。別リポジトリ専用の定型文も所属を保ったまま直せる */
let editingRepo: string | undefined;
let options: QuickPhraseOptions | null = null;
/** バーのチップをキーボードで選んでいる最中か（Cmd/Ctrl+P で入る） */
let selecting = false;
let selectedIndex = 0;
let barChips: HTMLButtonElement[] = [];
/** バーに出している定型文（= 汎用 + 現在のリポジトリ専用）。チップと同じ並び */
let barPhrases: QuickPhrase[] = [];
/** 管理モーダルでドラッグ中の保存配列インデック */
let draggingIndex: number | null = null;
/** 挿入先を明示指定して開いたときの対象欄（例: ペア設定の「最初のタスク」）。
    null ならこれまでどおりフォーカス中のターミナルへ入力する。閉じると解除される。 */
let insertTarget: HTMLInputElement | HTMLTextAreaElement | null = null;
// 1行表示の状態は session.json に保存する。「一度たたんだら自分で開くまで全展開しない」ため、
// 変更や再起動で勝手に開かない（変更ストリップと同じ扱い）
let barCollapsed = true;
// Cmd/Ctrl+P の自動展開・選択後の自動収納は一時状態。次回起動時の既定値は、ユーザーが
// 左の開閉操作（または同等の空白クリック）で最後に明示した状態だけを保存する。
let preferredBarCollapsed = true;

/** macOS の overlay scrollbar 設定に依存せず、収納中の横スクロール位置を常時見せる。 */
function syncBarScrollbar(): void {
  const maxScroll = Math.max(0, barListEl.scrollWidth - barListEl.clientWidth);
  const scrollable = barCollapsed && !barEl.hidden && maxScroll > 1;
  barScrollbarEl.hidden = !scrollable;
  if (!scrollable) return;
  const trackWidth = barScrollbarEl.clientWidth;
  const thumbWidth = Math.max(24, trackWidth * (barListEl.clientWidth / barListEl.scrollWidth));
  const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
  const thumbLeft = maxScroll ? (barListEl.scrollLeft / maxScroll) * maxThumbLeft : 0;
  barScrollThumbEl.style.width = `${thumbWidth}px`;
  barScrollThumbEl.style.transform = `translateX(${thumbLeft}px)`;
  barScrollbarEl.setAttribute("aria-valuemax", String(Math.round(maxScroll)));
  barScrollbarEl.setAttribute("aria-valuenow", String(Math.round(barListEl.scrollLeft)));
}

function setBarScrollFromTrack(clientX: number): void {
  const track = barScrollbarEl.getBoundingClientRect();
  const thumb = barScrollThumbEl.getBoundingClientRect();
  const maxScroll = Math.max(0, barListEl.scrollWidth - barListEl.clientWidth);
  const maxThumbLeft = Math.max(0, track.width - thumb.width);
  if (!maxScroll || !maxThumbLeft) return;
  const thumbLeft = Math.max(0, Math.min(maxThumbLeft, clientX - track.left - thumb.width / 2));
  barListEl.scrollLeft = (thumbLeft / maxThumbLeft) * maxScroll;
}

function normalizePhrase(value: string): string {
  // 定型文は制御文字を含まない一言として扱う。手編集した保存データに Enter や
  // エスケープシーケンスが混ざっていても、意図せず実行・制御しないよう空白へ畳む。
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 500);
}

/** 同じ内容でもリポジトリが違えば別の定型文（汎用と専用は共存できる） */
function sameEntry(a: QuickPhrase, text: string, repo: string | undefined): boolean {
  return a.text === text && (a.repo ?? "") === (repo ?? "");
}

/** リポジトリの表示名（フルパスは title で読ませる） */
function repoName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** バーに出す定型文: 汎用 + いま監視しているリポジトリ専用のもの */
function visiblePhrases(): QuickPhrase[] {
  return phrases.filter((p) => !p.repo || p.repo === currentRepo);
}

/** 「このリポジトリ」ラジオが指す先。編集中はその項目の所属を優先する */
function scopeTargetRepo(): string | null {
  if (editingIndex !== null && editingRepo) return editingRepo;
  return currentRepo;
}

function resetEditor() {
  editingIndex = null;
  editingRepo = undefined;
  input.value = "";
}

function setOpen(open: boolean) {
  overlay.hidden = !open;
  openBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    renderQuickPhrasesTexts();
    input.focus();
  } else {
    resetEditor();
    // 挿入対象の指定はモーダルを開いていた間だけ有効。次に汎用の入口（ツールバー等）から
    // 開いたときはターミナルへ戻す
    insertTarget = null;
    renderQuickPhrasesTexts();
    // 閉じてもフォーカスが（非表示になった）入力欄に残ると、パネルの stopPropagation が
    // Cmd/Ctrl+P などのショートカットを飲んでしまう。必ずターミナルへ返す
    // （挿入対象の欄へ既にフォーカスを戻している場合はここに該当しない）
    if (overlay.contains(document.activeElement)) options?.focusTerminal();
  }
}

/** 他モーダルの入力欄（例: ペア設定の「最初のタスク」）へ挿入する対象を指定して開く。
    閉じると対象は解除され、以後はまた既定のフォーカス中ターミナルへ戻る。 */
export function openQuickPhrasesFor(target: HTMLInputElement | HTMLTextAreaElement) {
  insertTarget = target;
  setOpen(true);
}

/** カーソル位置（無ければ末尾）へ定型文を挿入する。直前が空白/改行でなければ1つ空ける。
    maxlength に収まらない分は前後の既存文字列ではなく挿入文字列側だけを切り詰める。 */
function insertIntoField(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const sep = before && !/\s$/.test(before) ? " " : "";
  const maxLen = el.maxLength >= 0 ? el.maxLength : Infinity;
  const room = Math.max(0, maxLen - before.length - after.length);
  const insertion = (sep + text).slice(0, room);
  el.value = before + insertion + after;
  const pos = before.length + insertion.length;
  el.focus();
  el.setSelectionRange(pos, pos);
  // value を直接書き換えただけでは変更を監視しているリスナー（保存トリガー等）に届かない
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 挿入先が指定されていればそこへ、無ければ従来どおりフォーカス中のターミナルへ入力する。 */
function insertPhrase(text: string): boolean {
  if (insertTarget && insertTarget.isConnected) {
    insertIntoField(insertTarget, text);
    return true;
  }
  return options?.insert(text) ?? false;
}

function commitChange() {
  options?.onChange();
  renderQuickPhrasesTexts();
}

function editPhrase(index: number) {
  const target = phrases[index];
  if (!target) return;
  editingIndex = index;
  editingRepo = target.repo;
  input.value = target.text;
  // 保存先の選択も編集対象に合わせる（別リポジトリ専用のものはその所属のまま直せる）
  scopeRepoRadio.checked = Boolean(target.repo);
  scopeGlobalRadio.checked = !target.repo;
  renderQuickPhrasesTexts();
  input.focus();
  input.select();
}

function deletePhrase(index: number) {
  phrases.splice(index, 1);
  if (editingIndex === index) resetEditor();
  else if (editingIndex !== null && editingIndex > index) editingIndex--;
  commitChange();
}

function clearDropIndicators() {
  listEl.querySelectorAll(".drop-before, .drop-after").forEach((el) => {
    el.classList.remove("drop-before", "drop-after");
  });
}

/** 保存配列の1件を finalIndex へ移し、編集中の対象も同じ項目を指し続ける。 */
function movePhrase(from: number, finalIndex: number): boolean {
  if (from < 0 || from >= phrases.length) return false;
  const to = Math.max(0, Math.min(finalIndex, phrases.length - 1));
  if (from === to) return false;
  const editingPhrase = editingIndex === null ? null : phrases[editingIndex];
  const [moved] = phrases.splice(from, 1);
  phrases.splice(to, 0, moved);
  if (editingPhrase) editingIndex = phrases.indexOf(editingPhrase);
  commitChange();
  return true;
}

/** 入力欄の下のラジオを現在の状況に合わせる（リポジトリ外では専用を選べない） */
function renderScope() {
  scopeTitleEl.textContent = t("quick.scopeTitle");
  scopeGlobalLabel.textContent = t("quick.scopeGlobal");
  const target = scopeTargetRepo();
  scopeRepoLabel.textContent = target
    ? t("quick.scopeRepo", { repo: repoName(target) })
    : t("quick.scopeRepoNone");
  scopeRepoLabel.title = target ?? "";
  scopeRepoRadio.disabled = !target;
  // リポジトリ外へ移動したら選択は汎用へ戻す（保存先の無いラジオを選んだままにしない）
  if (!target && scopeRepoRadio.checked) scopeGlobalRadio.checked = true;
}

function renderList() {
  listEl.textContent = "";
  emptyEl.hidden = phrases.length > 0;

  phrases.forEach((phrase, index) => {
    const row = document.createElement("div");
    row.className = "quick-phrase-row";
    row.setAttribute("role", "listitem");
    row.dataset.phraseIndex = String(index);
    row.draggable = true;
    // 別リポジトリ専用のものは今は使えない（バーにも出ない）ので控えめに見せる
    if (phrase.repo && phrase.repo !== currentRepo) row.classList.add("is-inactive");

    const reorder = document.createElement("button");
    reorder.type = "button";
    reorder.className = "quick-phrase-reorder";
    reorder.textContent = "↕";
    reorder.title = t("quick.reorderTitle", { text: phrase.text });
    reorder.setAttribute("aria-label", reorder.title);
    row.ondragstart = (e) => {
      draggingIndex = index;
      row.classList.add("is-dragging");
      reorder.setAttribute("aria-grabbed", "true");
      // WebKit は setData が無い HTML5 DnD を開始しない。中身は使わず配列 index だけ持たせる。
      e.dataTransfer?.setData("text/plain", String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    };
    row.ondragend = () => {
      draggingIndex = null;
      row.classList.remove("is-dragging");
      reorder.setAttribute("aria-grabbed", "false");
      clearDropIndicators();
    };
    reorder.onkeydown = (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const target = index + (e.key === "ArrowUp" ? -1 : 1);
      if (!movePhrase(index, target)) return;
      listEl.querySelector<HTMLButtonElement>(`[data-phrase-index="${target}"] .quick-phrase-reorder`)?.focus();
    };

    row.ondragover = (e) => {
      if (draggingIndex === null || draggingIndex === index) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      clearDropIndicators();
      const rect = row.getBoundingClientRect();
      row.classList.add(e.clientY < rect.top + rect.height / 2 ? "drop-before" : "drop-after");
    };
    row.ondragleave = (e) => {
      if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return;
      row.classList.remove("drop-before", "drop-after");
    };
    row.ondrop = (e) => {
      e.preventDefault();
      const from = draggingIndex;
      draggingIndex = null;
      clearDropIndicators();
      if (from === null || from === index) return;
      const rect = row.getBoundingClientRect();
      const after = e.clientY >= rect.top + rect.height / 2;
      // ドロップ位置は「行の前/後」。元を抜いた分だけ後方 index を補正する。
      let target = index + (after ? 1 : 0);
      if (from < target) target--;
      movePhrase(from, target);
    };

    const use = document.createElement("button");
    use.type = "button";
    use.className = "quick-phrase-use";
    use.textContent = phrase.text;
    use.title = t("quick.insertTitle");
    use.onclick = () => {
      if (insertPhrase(phrase.text)) {
        setOpen(false);
        setBarCollapsed(true, false);
      }
    };

    const actions = document.createElement("div");
    actions.className = "quick-phrase-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = t("quick.edit");
    edit.title = t("quick.editTitle");
    edit.onclick = () => editPhrase(index);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "quick-phrase-delete";
    del.textContent = t("quick.delete");
    del.title = t("quick.deleteTitle");
    del.onclick = () => deletePhrase(index);

    actions.append(edit, del);
    row.append(reorder, use);
    if (phrase.repo) {
      // 汎用はタグ無し（大半が汎用なので、専用のときだけ所属を明示する）
      const tag = document.createElement("span");
      tag.className = "quick-phrase-scope-tag";
      tag.textContent = repoName(phrase.repo);
      tag.title = t("quick.scopeRowTitle", { repo: phrase.repo });
      row.append(tag);
    }
    row.append(actions);
    listEl.append(row);
  });
}

/** 選択状態（`.is-active` と roving tabindex）とヒント文言を貼り直す。
    チップの作り直しはしないので、フォーカスを持ったまま呼べる。 */
function applyBarSelection() {
  barChips.forEach((chip, index) => {
    const active = selecting && index === selectedIndex;
    chip.classList.toggle("is-active", active);
    // roving tabindex: 選択中はその1つだけ、通常時は先頭だけを Tab の入口にする
    chip.tabIndex = (selecting ? active : index === 0) ? 0 : -1;
  });
  barHintEl.textContent = selecting ? t("quick.navHint") : t("quick.barSelect");
  barHintEl.classList.toggle("is-active", selecting);
}

function moveSelection(delta: number) {
  if (!barChips.length) return;
  selecting = true;
  const n = barChips.length;
  selectedIndex = ((selectedIndex + delta) % n + n) % n;
  applyBarSelection();
  const chip = barChips[selectedIndex];
  chip.focus();
  chip.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function exitSelection(refocusTerminal: boolean) {
  if (!selecting) return;
  selecting = false;
  applyBarSelection();
  if (refocusTerminal) options?.focusTerminal();
}

/** ショートカット（Cmd/Ctrl+P）からキーボード選択を始める。
    登録が 0 件のときは選ぶものが無いので管理モーダルを開く。 */
export function startQuickPhraseSelection() {
  if (!requireFeature()) return; // 定型文はソフトロック対象（Cmd/Ctrl+P もここを通る）
  if (!visiblePhrases().length) {
    setOpen(true);
    return;
  }
  // たたんでいてもショートカットは「定型文を使う」意思表示なので開いてから選ばせる
  if (barCollapsed) setBarCollapsed(false, false);
  if (!overlay.hidden) setOpen(false);
  selecting = true;
  if (selectedIndex >= barChips.length) selectedIndex = 0;
  moveSelection(0);
}

/** たたむボタン・件数表示・中身の表示を現在の状態に合わせる */
function applyBarCollapsed() {
  // content は隠さず、CSS でチップを1行に切り詰める。hidden は旧状態からの復元対策で外す。
  barContentEl.hidden = false;
  barEl.classList.toggle("is-collapsed", barCollapsed);
  barCollapseBtn.textContent = barCollapsed ? "▸" : "▾";
  barCollapseBtn.setAttribute("aria-expanded", String(!barCollapsed));
  barCollapseBtn.title = t(barCollapsed ? "quick.barExpand" : "quick.barCollapse");
  // 1行表示の間だけ件数を見出しの右に出す（隠れた行の概要）
  barSummaryEl.hidden = !barCollapsed || barPhrases.length === 0;
  barSummaryEl.textContent = barSummaryEl.hidden
    ? ""
    : t("quick.barCount", { n: String(barPhrases.length) });
  requestAnimationFrame(syncBarScrollbar);
}

function setBarCollapsed(collapsed: boolean, persistPreference = true) {
  if (barCollapsed === collapsed) return;
  barCollapsed = collapsed;
  if (collapsed) exitSelection(false); // 横スクロールの外へ移ったチップにフォーカスを残さない
  applyBarCollapsed();
  if (persistPreference) {
    preferredBarCollapsed = collapsed;
    options?.onChange(); // ユーザーが明示した既定状態だけを保存する
  }
  options?.layout(); // 帯の高さが変わる（変更ストリップと同じ理由で refit 必須）
}

/** 起動時の復元用（保存も再レイアウトもせず状態だけ合わせる） */
export function setQuickPhraseBarCollapsed(collapsed: boolean) {
  barCollapsed = preferredBarCollapsed = collapsed;
  applyBarCollapsed();
}

export function isQuickPhraseBarCollapsed(): boolean {
  return preferredBarCollapsed;
}

/** 監視中のリポジトリ（変更ストリップの git ポーリング結果）を受け取る。
    ここが変わるとバーに出す「リポジトリ専用」の定型文が入れ替わる。 */
export function setQuickPhraseRepo(root: string | null) {
  if (currentRepo === root) return;
  currentRepo = root;
  renderQuickPhrasesTexts();
}

/** 定型文バー（ターミナル上部・変更ストリップのすぐ上）を描き直す。
    出せるものが 0 件のときは帯ごと隠し、その分ターミナルの高さを返す。 */
function renderBar() {
  const wasHidden = barEl.hidden;
  const beforeHeight = barEl.getBoundingClientRect().height;
  barPhrases = visiblePhrases();
  // 定型文はソフトロック対象: Locked 中はバーごと隠す（入口はツールバーの 🔒 ボタンに残る）
  barEl.hidden = barPhrases.length === 0 || isLocked();
  barTitleBtn.textContent = t("quick.toolbar");
  barTitleBtn.title = t("quick.barTitle");
  barListEl.setAttribute("aria-label", t("quick.title"));

  barListEl.textContent = "";
  barChips = barPhrases.map((phrase) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "quick-phrase-chip";
    chip.textContent = phrase.text;
    if (phrase.repo) {
      chip.classList.add("is-repo");
      chip.title = t("quick.chipRepoTitle", { repo: repoName(phrase.repo) });
    } else {
      chip.title = t("quick.insertTitle");
    }
    // クリックは入力のみ（誤実行防止）。
    chip.onclick = () => {
      insertPhrase(phrase.text);
      setBarCollapsed(true, false);
    };
    barListEl.append(chip);
    return chip;
  });
  if (selectedIndex >= barChips.length) selectedIndex = 0;
  if (!barChips.length) selecting = false;
  applyBarSelection();
  applyBarCollapsed();
  requestAnimationFrame(syncBarScrollbar);

  // 帯の有無、または全展開中の行数が変わったときだけ refit（1行表示の高さは固定）。
  const heightChanged = Math.abs(barEl.getBoundingClientRect().height - beforeHeight) > 0.5;
  if (wasHidden !== barEl.hidden || (!barCollapsed && !barEl.hidden && heightChanged)) options?.layout();
}

/** 言語切替時に動的な一覧・ボタン文言を貼り直す。 */
export function renderQuickPhrasesTexts() {
  // 他モーダルの入力欄を対象に開いているときは「ターミナルへ入力」ではなく
  // 「この欄へ入力」であることを案内する（data-i18n の既定文言を上書き）
  hintEl.textContent = t(insertTarget ? "quick.hintTarget" : "quick.hint");
  emptyEl.textContent = t("quick.empty");
  input.setAttribute("aria-label", t("quick.placeholder"));
  cancelBtn.textContent = t("quick.cancel");
  cancelBtn.hidden = editingIndex === null;
  submitBtn.textContent = editingIndex === null ? t("quick.add") : t("quick.save");
  renderScope();
  renderList();
  renderBar();
}

/** session.json から復元。壊れた値・空文字・重複は読み飛ばす。
    v3 までの文字列配列（= 全部が汎用）もそのまま読める。 */
export function setQuickPhrases(value: unknown) {
  const next: QuickPhrase[] = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      let text = "";
      let repo: string | undefined;
      if (typeof raw === "string") {
        text = normalizePhrase(raw);
      } else if (raw && typeof raw === "object") {
        const entry = raw as { text?: unknown; repo?: unknown };
        if (typeof entry.text === "string") text = normalizePhrase(entry.text);
        if (typeof entry.repo === "string" && entry.repo.trim()) repo = entry.repo;
      }
      if (!text) continue;
      if (next.some((p) => sameEntry(p, text, repo))) continue;
      next.push(repo ? { text, repo } : { text });
    }
  }
  phrases = next;
  resetEditor();
  renderQuickPhrasesTexts();
}

export function getQuickPhrases(): QuickPhrase[] {
  return phrases.map((p) => ({ ...p }));
}

export function initQuickPhrases(nextOptions: QuickPhraseOptions) {
  options = nextOptions;
  openBtn.onclick = () => {
    if (requireFeature()) setOpen(true); // 定型文はソフトロック対象
  };
  barTitleBtn.onclick = () => {
    if (requireFeature()) setOpen(true);
  };
  // Locked への遷移でバーを隠し、解除で戻す（表示切替は renderBar が layout まで面倒を見る）
  onLicenseChange(() => renderBar());
  barCollapseBtn.onclick = () => setBarCollapsed(!barCollapsed);
  barListEl.addEventListener("scroll", syncBarScrollbar, { passive: true });
  new ResizeObserver(syncBarScrollbar).observe(barScrollEl);
  let dragStartX = 0;
  let dragStartScrollLeft = 0;
  barScrollThumbEl.onpointerdown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragStartX = e.clientX;
    dragStartScrollLeft = barListEl.scrollLeft;
    barScrollThumbEl.setPointerCapture(e.pointerId);
  };
  barScrollThumbEl.onpointermove = (e) => {
    if (!barScrollThumbEl.hasPointerCapture(e.pointerId)) return;
    const maxThumbLeft = Math.max(0, barScrollbarEl.clientWidth - barScrollThumbEl.getBoundingClientRect().width);
    const maxScroll = Math.max(0, barListEl.scrollWidth - barListEl.clientWidth);
    if (maxThumbLeft) {
      barListEl.scrollLeft = dragStartScrollLeft + (e.clientX - dragStartX) * maxScroll / maxThumbLeft;
    }
  };
  barScrollThumbEl.onpointerup = (e) => {
    if (barScrollThumbEl.hasPointerCapture(e.pointerId)) barScrollThumbEl.releasePointerCapture(e.pointerId);
  };
  barScrollbarEl.onpointerdown = (e) => {
    e.stopPropagation();
    if (e.target === barScrollbarEl) setBarScrollFromTrack(e.clientX);
  };
  barScrollbarEl.onclick = (e) => e.stopPropagation();
  barScrollbarEl.onwheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    barListEl.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  };
  barScrollbarEl.onkeydown = (e) => {
    const page = Math.max(40, barListEl.clientWidth * 0.8);
    let delta = 0;
    if (e.key === "ArrowLeft") delta = -40;
    else if (e.key === "ArrowRight") delta = 40;
    else if (e.key === "PageUp") delta = -page;
    else if (e.key === "PageDown") delta = page;
    else if (e.key === "Home") delta = -barListEl.scrollWidth;
    else if (e.key === "End") delta = barListEl.scrollWidth;
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    barListEl.scrollLeft += delta;
  };
  closeBtn.onclick = () => setOpen(false);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) setOpen(false);
  });
  // 入力中のキーをアプリショートカットやターミナルへ流さない（開いている間だけ）。
  panel.addEventListener("keydown", (e) => {
    if (!overlay.hidden) e.stopPropagation();
  });
  // 見出し行のボタン操作もターミナル・ショートカットへ流さない（変更ストリップと同じ流儀）
  barEl.addEventListener("keydown", (e) => {
    if (e.target === barCollapseBtn || e.target === barTitleBtn) e.stopPropagation();
  });
  // 三角ボタン以外に「帯の空白」クリックでも開閉する（変更ストリップと同じ作り）。
  // コンテナ要素そのものを踏んだときだけ反応するので、チップ・見出しボタン・ヒントは誤爆しない。
  const barHitAreas: Element[] = [barEl, barHeadEl, barContentEl, barSummaryEl, barListEl];
  const consumeSelectionDrag = trackSelectionDrag(barEl);
  barEl.addEventListener("click", (e) => {
    const selectedByThisDrag = consumeSelectionDrag();
    if (!barHitAreas.includes(e.target as Element)) return;
    if (selectedByThisDrag) return; // 今回のドラッグで文字を選んだ直後だけはたたまない
    setBarCollapsed(!barCollapsed);
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!overlay.hidden && e.key === "Escape") {
        // stopImmediatePropagation: 他モーダル（ペア設定など）の上に重ねて開いているとき、
        // 同じ window capture 段の Escape ハンドラを止めないと1回の Escape で
        // 両方閉じてしまう。ここは常にこのモーダルだけを閉じる
        e.stopImmediatePropagation();
        setOpen(false);
      }
    },
    true,
  );

  // --- バーのキーボード操作（Tab / 矢印で移動、Enter で入力、Esc で終了） ---
  barListEl.addEventListener("keydown", (e) => {
    if (!barChips.length) return;
    if (e.altKey) return;
    // Cmd/Ctrl 併用はアプリのショートカット（Cmd+P で入り直す等）に通す
    if (e.metaKey || e.ctrlKey) return;

    let delta = 0;
    if (e.key === "Tab") delta = e.shiftKey ? -1 : 1;
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") delta = 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") delta = -1;
    if (delta) {
      // Tab はバーの中で巡回させる（選択モードは Esc / Enter で抜ける）
      e.preventDefault();
      e.stopPropagation();
      moveSelection(delta);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = e.key === "Home" ? 0 : barChips.length - 1;
      moveSelection(0);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exitSelection(true);
      return;
    }
    if (e.key === "Enter") {
      // 1回目の Enter は定型文だけを入力してターミナルへ戻る。
      // 実行はユーザーが内容を確認し、2回目の Enter で行う。
      e.preventDefault();
      e.stopPropagation();
      const phrase = barPhrases[selectedIndex];
      if (phrase !== undefined) insertPhrase(phrase.text);
      setBarCollapsed(true, false);
      return;
    }
    if (e.key === " ") {
      // Space は既定の click（入力のみ・実行しない）へ。ページスクロールだけ止める
      e.stopPropagation();
    }
  });
  barEl.addEventListener("focusout", (e) => {
    const next = e.relatedTarget as Node | null;
    if (next && barEl.contains(next)) return;
    exitSelection(false);
  });

  cancelBtn.onclick = () => {
    resetEditor();
    renderQuickPhrasesTexts();
    input.focus();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = normalizePhrase(input.value);
    if (!text) return;
    const target = scopeTargetRepo();
    const repo = scopeRepoRadio.checked && target ? target : undefined;
    if (editingIndex === null) {
      if (!phrases.some((p) => sameEntry(p, text, repo))) phrases.push(repo ? { text, repo } : { text });
    } else {
      const duplicate = phrases.findIndex((p) => sameEntry(p, text, repo));
      if (duplicate < 0 || duplicate === editingIndex) {
        phrases[editingIndex] = repo ? { text, repo } : { text };
      } else {
        phrases.splice(editingIndex, 1); // 同じ保存先に同じ内容が既にあれば既存の1件へ集約
      }
    }
    resetEditor();
    commitChange();
    input.focus();
  };
  renderQuickPhrasesTexts();
}
