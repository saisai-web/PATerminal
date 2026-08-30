// ============================================================
// 画像パスのターミナル入力
// ネイティブ選択で得た絶対パスを、フォーカス中ペインのシェル向けに引用して挿入する。
// Claude / Codex 側へは画像データではなく通常のファイルパスとして渡す。
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import { quotePathFor } from "../explorer/paths";
import { broadcastWrite } from "../../terminal/focus";
import { getActiveWs, getFocusedId } from "../../workspace/state";

const IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "avif",
  "heic",
  "heif",
];

const attachImageBtn = document.querySelector<HTMLButtonElement>("#attach-image")!;

export function initImageAttachments(): void {
  attachImageBtn.onclick = () => void chooseImages();
}

async function chooseImages(): Promise<void> {
  const ws = getActiveWs();
  const focusedId = getFocusedId();
  const pane = focusedId ? ws?.panes.get(focusedId) : undefined;
  if (!ws || !pane) return;

  let defaultPath = pane.cwd ?? pane.initialCwd ?? pane.spec.cwd;
  try {
    defaultPath = (await invoke<string | null>("pty_cwd", { id: pane.id })) ?? defaultPath;
  } catch {
    // 終了済みプロセス等では OSC 7 / 起動時 cwd の値をそのまま使う。
  }

  attachImageBtn.disabled = true;
  try {
    const selected = await open({
      directory: false,
      multiple: true,
      title: t("image.attachTitle"),
      defaultPath,
      filters: [{ name: t("image.attach"), extensions: IMAGE_EXTENSIONS }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!paths.length || !pane.alive || !ws.panes.has(pane.id)) return;

    // macOS の Terminal へファイルを落とした時と同じく、次の入力を続けられる空白を末尾に置く。
    const data = `${paths.map((path) => quotePathFor(pane, path)).join(" ")} `;
    if (ws.broadcast) broadcastWrite(ws, data);
    else pane.write(data);
    pane.focus();
  } catch (e) {
    console.error("image picker failed:", e);
    pane.focus();
  } finally {
    attachImageBtn.disabled = false;
  }
}
