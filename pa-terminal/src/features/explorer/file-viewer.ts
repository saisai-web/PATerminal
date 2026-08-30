// ============================================================
// ファイルビューア / 簡易編集モーダル（エクスプローラーのファイルクリックで開く。
// diff オーバーレイと同じ操作系のモーダルなので layout() には触れない）
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";

const fileOverlay = document.querySelector<HTMLDivElement>("#file-overlay")!;
const filePanel = document.querySelector<HTMLDivElement>("#file-panel")!;
const filePathEl = document.querySelector<HTMLSpanElement>("#file-path")!;
const fileNoteEl = document.querySelector<HTMLSpanElement>("#file-note")!;
const fileSaveBtn = document.querySelector<HTMLButtonElement>("#file-save")!;
const fileCloseBtn = document.querySelector<HTMLButtonElement>("#file-close")!;
const fileBodyEl = document.querySelector<HTMLTextAreaElement>("#file-body")!;
const fileImageEl = document.querySelector<HTMLImageElement>("#file-image")!;

type FsFile = { text: string; truncated: boolean; binary: boolean };

let fileViewPath: string | null = null;
let fileOrig = ""; // 最後に読み込み / 保存した内容（dirty 判定の基準）
let fileReadOnly = false;
let fileCloseArmed = false; // 未保存のまま閉じようとした1回目（2回目で破棄して閉じる）
let fileImageUrl: string | null = null;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
};

function imageMime(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

function fileDirty(): boolean {
  return !fileReadOnly && fileBodyEl.value !== fileOrig;
}

function setFileNote(msg: string | null) {
  fileNoteEl.hidden = !msg;
  fileNoteEl.textContent = msg ?? "";
}

function clearImagePreview(): void {
  fileImageEl.onload = null;
  fileImageEl.onerror = null;
  fileImageEl.removeAttribute("src");
  fileImageEl.hidden = true;
  if (fileImageUrl) URL.revokeObjectURL(fileImageUrl);
  fileImageUrl = null;
}

export async function openFileViewer(path: string): Promise<void> {
  fileViewPath = path;
  fileCloseArmed = false;
  filePathEl.textContent = path;
  filePathEl.title = path;
  clearImagePreview();
  fileBodyEl.value = "";
  fileOrig = "";
  setFileNote(null);
  fileOverlay.hidden = false;

  const mime = imageMime(path);
  if (mime) {
    fileReadOnly = true;
    fileBodyEl.hidden = true;
    fileBodyEl.readOnly = true;
    fileSaveBtn.hidden = true;
    fileSaveBtn.disabled = true;
    let bytes: ArrayBuffer | null = null;
    let err: string | null = null;
    try {
      bytes = await invoke<ArrayBuffer>("fs_read_image", { path });
    } catch (e) {
      err = String(e);
    }
    if (fileViewPath !== path) return;
    if (!bytes) {
      setFileNote(t("file.readError", { error: err ?? "unknown error" }));
      return;
    }
    fileImageUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    fileImageEl.onload = () => {
      if (fileViewPath === path) setFileNote(null);
    };
    fileImageEl.onerror = () => {
      if (fileViewPath === path) setFileNote(t("file.binary"));
    };
    fileImageEl.src = fileImageUrl;
    fileImageEl.hidden = false;
    return;
  }

  fileBodyEl.hidden = false;
  fileSaveBtn.hidden = false;
  let r: FsFile | null = null;
  let err: string | null = null;
  try {
    r = await invoke<FsFile>("fs_read", { path });
  } catch (e) {
    err = String(e);
  }
  if (fileViewPath !== path) return; // await の間に別のファイルへ切り替わった（追い越し）
  // バイナリ / 1MB 超 / 読み込み失敗は読み取り専用（保存させない）
  fileReadOnly = !r || r.binary || r.truncated;
  fileBodyEl.value = r?.binary ? "" : (r?.text ?? "");
  fileOrig = fileBodyEl.value;
  fileBodyEl.readOnly = fileReadOnly;
  setFileNote(
    err
      ? t("file.readError", { error: err })
      : r!.binary
        ? t("file.binary")
        : r!.truncated
          ? t("file.truncated")
          : null,
  );
  fileSaveBtn.disabled = true; // 開いた直後は未変更
  if (!fileReadOnly) fileBodyEl.focus();
}

async function saveFileViewer(): Promise<void> {
  if (!fileViewPath || fileReadOnly || !fileDirty()) return;
  const path = fileViewPath;
  const text = fileBodyEl.value;
  try {
    await invoke("fs_write", { path, text });
    if (fileViewPath !== path) return; // 保存中に別ファイルへ切り替わっていたら表示は触らない
    fileOrig = text;
    fileCloseArmed = false;
    fileSaveBtn.disabled = true;
    setFileNote(t("file.saved"));
  } catch (e) {
    if (fileViewPath !== path) return;
    setFileNote(t("file.saveError", { error: String(e) }));
  }
}

/** 未保存の変更があれば1回目は警告表示のみ。もう一度閉じる操作で破棄して閉じる */
function tryCloseFileViewer(): void {
  if (fileDirty() && !fileCloseArmed) {
    fileCloseArmed = true;
    setFileNote(t("file.confirmClose"));
    return;
  }
  fileOverlay.hidden = true;
  fileViewPath = null;
  clearImagePreview();
  fileBodyEl.hidden = false;
  fileSaveBtn.hidden = false;
  fileBodyEl.value = "";
  fileOrig = "";
}

fileBodyEl.addEventListener("input", () => {
  fileCloseArmed = false; // 打鍵したら「もう一度で破棄」を解除
  setFileNote(null); // readonly 中は input が発火しないので truncated/binary 表示は消えない
  fileSaveBtn.disabled = !fileDirty();
});

fileSaveBtn.onclick = () => void saveFileViewer();
fileCloseBtn.onclick = tryCloseFileViewer;
fileOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === fileOverlay) tryCloseFileViewer(); // バックドロップクリックで閉じる
});
// パネル内の打鍵をターミナルやショートカットに流さない + Cmd/Ctrl+S で保存
filePanel.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyS") {
    e.preventDefault();
    void saveFileViewer();
  }
});
window.addEventListener(
  "keydown",
  (e) => {
    if (!fileOverlay.hidden && e.key === "Escape") {
      e.stopPropagation();
      tryCloseFileViewer();
    }
  },
  true,
);
