import { Channel, invoke } from "@tauri-apps/api/core";

export type OfficialUpdateInfo = {
  currentVersion: string;
  version: string;
  body: string | null;
};

type DownloadEvent =
  | { event: "Started"; data: { contentLength: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export async function checkOfficialUpdate(): Promise<OfficialUpdateInfo | null> {
  return invoke<OfficialUpdateInfo | null>("official_update_check");
}

export async function installOfficialUpdate(onProgress: (ratio: number | null) => void): Promise<void> {
  let downloaded = 0;
  let contentLength: number | null = null;
  const channel = new Channel<DownloadEvent>();
  channel.onmessage = (message) => {
    if (message.event === "Started") {
      contentLength = message.data.contentLength;
      onProgress(contentLength ? 0 : null);
    } else if (message.event === "Progress") {
      downloaded += message.data.chunkLength;
      onProgress(contentLength ? Math.min(1, downloaded / contentLength) : null);
    } else {
      onProgress(1);
    }
  };
  await invoke("official_update_install", { onEvent: channel });
}
