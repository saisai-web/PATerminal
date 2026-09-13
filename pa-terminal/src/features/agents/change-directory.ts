import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import type { Pane } from "../../terminal/pane";
import { setFocused } from "../../terminal/focus";
import { replacePane } from "../../terminal/tree";
import { getActiveWs, getFocusedId, getHostOs, panes } from "../../workspace/state";
import type { PaneAgentInfo } from "../../workspace/types";
import { cdCommandFor } from "../explorer/paths";
import { requireFeature } from "../license/license";
import { recordRecentDir } from "../sidebar/recent-dirs";
import { isValidSessionId, resumeCommandFor } from "./agents";
import { agentForDirectoryChange } from "./watch";

let dismiss: (() => void) | undefined;
let beforeReplace: (pane: Pane) => void = () => {};

export function initDirectoryChange(opts: { beforeReplace: (pane: Pane) => void }) {
  beforeReplace = opts.beforeReplace;
  document.querySelector<HTMLButtonElement>("#pane-change-directory")!.onclick = () => {
    const id = getFocusedId();
    const pane = id ? panes.get(id) : undefined;
    if (pane) openDirectoryChange(pane);
  };
  // Delegate to the grid so restored and newly split panes get the same action.
  // Resolve the clicked pane explicitly, including keyboard activation in a
  // pane that was not previously focused.
  document.querySelector<HTMLDivElement>("#grid")!.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(".pane-cwd");
    const pane = button?.dataset.paneId ? panes.get(button.dataset.paneId) : undefined;
    if (!pane) return;
    event.stopPropagation();
    setFocused(pane.id);
    openDirectoryChange(pane);
  });
}

/** Explorer's existing cd action stays immediate for shells. Never inject shell
 * commands into a detected CLI, including one started since the last sweep. */
export async function moveTerminalTo(pane: Pane, path: string) {
  try {
    await validateDirectory(path);
    const agent = await agentForDirectoryChange(pane);
    if (agent) openDirectoryChange(pane, path);
    else {
      if (pane.alive && panes.get(pane.id) === pane) pane.write(`${cdCommandFor(pane, path)}\r`);
    }
  } catch (error) {
    openDirectoryChange(pane, path, String(error));
  }
}

async function validateDirectory(path: string) {
  const absolute = getHostOs() === "windows" ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(path) : path.startsWith("/");
  if (!absolute || /[\x00-\x1f\x7f]/.test(path)) throw new Error(t("move.absolutePath"));
  await invoke("fs_is_dir", { path });
}

/** Capture just this pane during an idle slice, using the existing mode-free
 * snapshot path. No serialization runs inside a key or PTY output callback. */
function captureHistory(pane: Pane): Promise<string | undefined> {
  return new Promise((resolve) => {
    const capture = () => {
      if (!pane.alive) return resolve(undefined);
      pane.refreshSnapshot();
      resolve(pane.snapshot());
    };
    if (window.requestIdleCallback) window.requestIdleCallback(capture, { timeout: 250 });
    else window.setTimeout(capture, 0);
  });
}

export function openDirectoryChange(pane: Pane, path?: string, initialError?: string) {
  dismiss?.();
  if (dismiss || !pane.alive || panes.get(pane.id) !== pane) return;
  const overlay = document.createElement("div");
  overlay.id = "move-directory-overlay";
  const panel = document.createElement("form");
  panel.id = "move-directory-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "move-directory-title");
  const title = document.createElement("h2");
  title.id = "move-directory-title";
  title.textContent = t("move.title");
  const description = document.createElement("p");
  description.id = "move-directory-description";
  const field = document.createElement("label");
  field.textContent = t("move.destination");
  const row = document.createElement("div");
  row.className = "move-directory-field";
  const input = document.createElement("input");
  input.id = "move-directory-path";
  input.value = path ?? pane.cwd ?? pane.spec.cwd ?? "";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.setAttribute("aria-describedby", description.id);
  field.htmlFor = input.id;
  const browse = document.createElement("button");
  browse.type = "button";
  browse.textContent = t("takeover.browse");
  const errorEl = document.createElement("p");
  errorEl.id = "move-directory-error";
  errorEl.setAttribute("role", "alert");
  errorEl.textContent = initialError ?? "";
  const actions = document.createElement("div");
  actions.className = "move-directory-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = t("takeover.cancel");
  const submit = document.createElement("button");
  submit.id = "move-directory-submit";
  submit.type = "submit";
  submit.className = "is-primary";
  submit.textContent = t("move.submit");
  let agent: PaneAgentInfo | null = null;
  let pending = false;
  let committing = false;
  let closed = false;
  const live = () => !closed && pane.alive && panes.get(pane.id) === pane;
  const setPending = (value: boolean) => {
    pending = value;
    input.disabled = browse.disabled = submit.disabled = value;
    panel.setAttribute("aria-busy", String(value));
  };
  const render = () => {
    description.textContent = agent ? t("move.agent", { agent: agent.kind }) : t("move.shell");
  };
  const close = () => {
    if (committing) return;
    closed = true;
    overlay.remove();
    if (dismiss === close) dismiss = undefined;
    if (pane.ws === getActiveWs() && getFocusedId() === pane.id && pane.alive) pane.focus();
  };
  dismiss = close;
  cancel.onclick = close;
  overlay.onclick = (event) => { if (event.target === overlay) close(); };
  panel.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      const controls = [input, browse, cancel, submit].filter((el) => !el.disabled);
      const index = controls.indexOf(document.activeElement as typeof input);
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === controls.length - 1)) {
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
      }
    }
  };
  browse.onclick = async () => {
    setPending(true);
    try {
      const picked = await openFolderDialog({ directory: true, multiple: false,
        title: t("move.destination"), defaultPath: input.value || undefined });
      if (!closed && typeof picked === "string") input.value = picked;
    } catch (error) {
      if (!closed) errorEl.textContent = String(error);
    } finally {
      setPending(false);
      if (!closed) input.focus();
    }
  };
  panel.onsubmit = async (event) => {
    event.preventDefault();
    if (pending || closed) return;
    setPending(true);
    errorEl.textContent = "";
    try {
      const destination = input.value.trim();
      await validateDirectory(destination);
      const current = await agentForDirectoryChange(pane);
      if (!live()) return;
      if (current?.kind !== agent?.kind || (agent?.sessionId && current?.sessionId !== agent.sessionId)) {
        agent = current;
        render();
        throw new Error(t("move.changed"));
      }
      agent = current;
      if (!current) {
        pane.write(`${cdCommandFor(pane, destination)}\r`);
        close();
        return;
      }
      if (!requireFeature()) return;
      // --continue / --last would select a different conversation at the new
      // location. Refuse before stopping anything unless an exact ID is known.
      if (!isValidSessionId(current.sessionId)) throw new Error(t("move.noSession"));
      const info = { ...current, useCurrentCwd: true };
      const command = resumeCommandFor(info)!;
      const scrollback = await captureHistory(pane);
      if (!live()) return;
      committing = true;
      cancel.disabled = true;
      beforeReplace(pane);
      // Launch through an interactive shell, including directly spawned CLIs.
      // Never reuse a saved command that could cd back or start a fresh session.
      const fresh = await replacePane(pane.ws, pane.id, {
        title: pane.spec.title,
        cwd: destination,
        run: command,
        resumeRun: command,
        agent: info,
      }, scrollback);
      if (fresh) recordRecentDir(destination);
      committing = false;
      close();
    } catch (error) {
      if (!closed) errorEl.textContent = String(error);
    } finally {
      committing = false;
      cancel.disabled = false;
      setPending(false);
      if (!closed) input.focus();
    }
  };
  row.append(input, browse);
  actions.append(cancel, submit);
  panel.append(title, description, field, row, errorEl, actions);
  overlay.append(panel);
  document.body.append(overlay);
  render();
  setPending(true);
  cancel.focus();
  void agentForDirectoryChange(pane).then((current) => {
    if (!live()) return;
    agent = current;
    render();
  }).catch((error) => {
    if (!closed) errorEl.textContent = String(error);
  }).finally(() => {
    setPending(false);
    if (!closed) { input.focus(); input.select(); }
  });
}
