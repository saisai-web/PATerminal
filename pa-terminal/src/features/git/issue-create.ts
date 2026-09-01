// Issue タブの作成モーダル。タイトル・本文とネイティブダイアログで選んだ添付パスを
// 1回の issue_create コマンドへ渡す。ファイル本体を IPC に載せず、Rust 側が直接読む。

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n";
import type { IssueCreated } from "./git-panel-types";

type IssueCreateDeps = {
  getRoot: () => string | null;
  onCreated: (root: string, issue: IssueCreated) => void | Promise<void>;
};

const MAX_ATTACHMENTS = 10;

const openBtn = document.querySelector<HTMLButtonElement>("#exp-git-create-issue")!;
const overlay = document.querySelector<HTMLDivElement>("#issue-create-overlay")!;
const panel = document.querySelector<HTMLFormElement>("#issue-create-panel")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#issue-create-close")!;
const titleInput = document.querySelector<HTMLInputElement>("#issue-create-title")!;
const bodyInput = document.querySelector<HTMLTextAreaElement>("#issue-create-description")!;
const addFilesBtn = document.querySelector<HTMLButtonElement>("#issue-create-add-files")!;
const fileList = document.querySelector<HTMLDivElement>("#issue-create-file-list")!;
const errorEl = document.querySelector<HTMLDivElement>("#issue-create-error")!;
const cancelBtn = document.querySelector<HTMLButtonElement>("#issue-create-cancel")!;
const submitBtn = document.querySelector<HTMLButtonElement>("#issue-create-submit")!;

let deps: IssueCreateDeps = { getRoot: () => null, onCreated: () => {} };
let activeTab = false;
let formRoot: string | null = null;
let attachmentPaths: string[] = [];
let busy = false;
let previousFocus: HTMLElement | null = null;

function pathName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

function showError(message: string | null): void {
  errorEl.hidden = !message;
  errorEl.textContent = message ?? "";
}

function renderAttachmentList(): void {
  fileList.replaceChildren();
  if (attachmentPaths.length === 0) {
    const empty = document.createElement("div");
    empty.className = "issue-create-files-empty";
    empty.textContent = t("issue.createNoFiles");
    fileList.append(empty);
    return;
  }
  for (const path of attachmentPaths) {
    const row = document.createElement("div");
    row.className = "issue-create-file";
    row.role = "listitem";
    row.title = path;
    const name = document.createElement("span");
    name.textContent = pathName(path);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = t("issue.createRemoveFile", { name: pathName(path) });
    remove.setAttribute("aria-label", remove.title);
    remove.disabled = busy;
    remove.onclick = () => {
      attachmentPaths = attachmentPaths.filter((item) => item !== path);
      renderAttachmentList();
    };
    row.append(name, remove);
    fileList.append(row);
  }
}

function renderBusyState(): void {
  titleInput.disabled = busy;
  bodyInput.disabled = busy;
  addFilesBtn.disabled = busy;
  closeBtn.disabled = busy;
  cancelBtn.disabled = busy;
  submitBtn.disabled = busy;
  submitBtn.textContent = t(busy ? "issue.creating" : "issue.createSubmit");
  renderAttachmentList();
}

export function renderIssueCreateTexts(): void {
  if (!overlay.hidden) {
    renderBusyState();
  }
}

export function initIssueCreate(next: IssueCreateDeps): void {
  deps = next;
  syncIssueCreateRoot();
}

export function setIssueCreateTabActive(active: boolean): void {
  activeTab = active;
  syncIssueCreateRoot();
}

export function syncIssueCreateRoot(): void {
  const root = deps.getRoot();
  openBtn.hidden = !activeTab;
  openBtn.disabled = !root;
  if (!overlay.hidden && root !== formRoot && !busy) closeIssueCreate();
}

function openIssueCreate(): void {
  const root = deps.getRoot();
  if (!root || busy) return;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  formRoot = root;
  attachmentPaths = [];
  titleInput.value = "";
  bodyInput.value = "";
  showError(null);
  overlay.hidden = false;
  renderBusyState();
  titleInput.focus();
}

function closeIssueCreate(): void {
  if (busy) return;
  overlay.hidden = true;
  formRoot = null;
  attachmentPaths = [];
  showError(null);
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
}

async function chooseAttachments(): Promise<void> {
  if (busy) return;
  addFilesBtn.disabled = true;
  try {
    const selected = await open({
      directory: false,
      multiple: true,
      title: t("issue.createAttachments"),
      defaultPath: formRoot ?? undefined,
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    const next = [...attachmentPaths];
    for (const path of paths) if (!next.includes(path)) next.push(path);
    if (next.length > MAX_ATTACHMENTS) {
      showError(t("issue.createTooManyFiles", { count: String(MAX_ATTACHMENTS) }));
      return;
    }
    attachmentPaths = next;
    showError(null);
    renderAttachmentList();
  } catch (error) {
    showError(t("issue.createFailed", { error: String(error) }));
  } finally {
    addFilesBtn.disabled = busy;
  }
}

async function submitIssue(): Promise<void> {
  const root = formRoot;
  if (!root || root !== deps.getRoot() || busy) return;
  const title = titleInput.value.trim();
  if (!title) {
    titleInput.focus();
    titleInput.reportValidity();
    return;
  }
  busy = true;
  showError(null);
  renderBusyState();
  try {
    const created = await invoke<IssueCreated>("issue_create", {
      root,
      title,
      body: bodyInput.value,
      attachmentPaths,
    });
    busy = false;
    closeIssueCreate();
    await deps.onCreated(root, created);
  } catch (error) {
    busy = false;
    showError(t("issue.createFailed", { error: String(error) }));
    renderBusyState();
    titleInput.focus();
  }
}

openBtn.onclick = openIssueCreate;
closeBtn.onclick = closeIssueCreate;
cancelBtn.onclick = closeIssueCreate;
addFilesBtn.onclick = () => void chooseAttachments();
panel.onsubmit = (event) => {
  event.preventDefault();
  void submitIssue();
};
overlay.addEventListener("pointerdown", (event) => {
  if (event.target === overlay) closeIssueCreate();
});
panel.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    panel.requestSubmit();
  }
});
window.addEventListener(
  "keydown",
  (event) => {
    if (!overlay.hidden && event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      closeIssueCreate();
    }
  },
  true,
);
