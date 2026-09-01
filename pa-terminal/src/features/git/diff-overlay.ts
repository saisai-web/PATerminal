// 作業ツリーのファイル差分とコミット全体の unified diff で共有するモーダル。
// DOM と Escape / バックドロップの操作系を一箇所に保ち、layout()/refit には触れない。

import { t } from "../../i18n";

export type FileDiff = { path: string; oldText?: string | null; newText: string };

export type CommitDiff = {
  patch: string;
  adds: number;
  dels: number;
  truncated: boolean;
};

type MultiFileLabels = {
  noDiff: string;
  files: (count: number) => string;
  fileList: string;
  truncated: string;
};

type DiffLine = { type: "ctx" | "add" | "del" | "skip"; text: string };

type CommitLine = {
  type: "ctx" | "add" | "del" | "hunk" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

type CommitFile = {
  path: string;
  oldPath: string | null;
  adds: number;
  dels: number;
  lines: CommitLine[];
};

const diffOverlay = document.querySelector<HTMLDivElement>("#diff-overlay")!;
const diffPanel = document.querySelector<HTMLDivElement>("#diff-panel")!;
const diffPathEl = document.querySelector<HTMLSpanElement>("#diff-path")!;
const diffStatsEl = document.querySelector<HTMLSpanElement>("#diff-stats")!;
const diffBodyEl = document.querySelector<HTMLDivElement>("#diff-body")!;
const diffCloseBtn = document.querySelector<HTMLButtonElement>("#diff-close")!;

const DIFF_MAX_LINES = 2000;

// ---- 行単位 LCS diff。共通部分は前後2行だけ残して畳む ----

function diffLineList(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.replace(/\n$/, "").split("\n") : [];
  const b = newText.length ? newText.replace(/\n$/, "").split("\n") : [];
  // 共通の先頭・末尾を先に落とす（大きいファイルの小さな変更で DP を避ける）
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const mid: DiffLine[] = [];
  if (am.length * bm.length > 250_000) {
    // 大差分は LCS を諦めて全削除 + 全追加
    for (const l of am) mid.push({ type: "del", text: l });
    for (const l of bm) mid.push({ type: "add", text: l });
  } else {
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        mid.push({ type: "ctx", text: am[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        mid.push({ type: "del", text: am[i++] });
      } else {
        mid.push({ type: "add", text: bm[j++] });
      }
    }
    while (i < n) mid.push({ type: "del", text: am[i++] });
    while (j < m) mid.push({ type: "add", text: bm[j++] });
  }

  const all: DiffLine[] = [
    ...a.slice(0, pre).map((text): DiffLine => ({ type: "ctx", text })),
    ...mid,
    ...a.slice(a.length - suf).map((text): DiffLine => ({ type: "ctx", text })),
  ];
  // 連続する共通行は前後 CONTEXT 行だけ残して「⋯」に畳む
  const CONTEXT = 2;
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flushRun = (isEdge: boolean) => {
    if (run.length <= CONTEXT * 2 + 1) {
      out.push(...run);
    } else {
      const head = out.length === 0 ? [] : run.slice(0, CONTEXT);
      const tail = isEdge ? [] : run.slice(-CONTEXT);
      out.push(...head, { type: "skip", text: "" }, ...tail);
    }
    run = [];
  };
  for (const l of all) {
    if (l.type === "ctx") run.push(l);
    else {
      flushRun(false);
      out.push(l);
    }
  }
  flushRun(true);
  return out;
}

function renderFileDiffBody(d: FileDiff): HTMLDivElement {
  const body = document.createElement("div");
  const lines = diffLineList(d.oldText ?? "", d.newText);
  let shown = 0;
  for (const l of lines) {
    if (shown >= DIFF_MAX_LINES) {
      appendLine(body, "skip", t("agent.diffTruncated", { n: String(lines.length - shown) }));
      break;
    }
    if (l.type === "skip") appendLine(body, "skip", "⋯");
    else {
      const mark = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      appendLine(body, l.type, `${mark} ${l.text}`);
    }
    shown++;
  }
  return body;
}

function appendLine(parent: HTMLElement, cls: string, text: string): void {
  const row = document.createElement("div");
  row.className = `diff-line ${cls}`;
  row.textContent = text;
  parent.append(row);
}

function cleanPatchPath(raw: string): string {
  const withoutTimestamp = raw.split("\t", 1)[0];
  const unquoted = withoutTimestamp.startsWith('"') && withoutTimestamp.endsWith('"')
    ? withoutTimestamp.slice(1, -1)
    : withoutTimestamp;
  return unquoted.replace(/^[ab]\//, "");
}

/** unified diff をファイルと行番号に分解する。生の git メタ情報を本文と混ぜないための表示用パーサ。 */
function parseCommitPatch(patch: string): { files: CommitFile[]; omitted: number } {
  if (!patch) return { files: [], omitted: 0 };
  const allLines = patch.replace(/\n$/, "").split("\n");
  const source = allLines.slice(0, DIFF_MAX_LINES);
  const files: CommitFile[] = [];
  let file: CommitFile | null = null;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  const ensureFile = (): CommitFile => {
    if (file) return file;
    file = { path: t("git.commitUnknownFile"), oldPath: null, adds: 0, dels: 0, lines: [] };
    files.push(file);
    return file;
  };

  for (const line of source) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/ b\/(.+)$/);
      file = {
        path: match ? cleanPatchPath(`b/${match[1]}`) : t("git.commitUnknownFile"),
        oldPath: null,
        adds: 0,
        dels: 0,
        lines: [],
      };
      files.push(file);
      oldLine = null;
      newLine = null;
      continue;
    }

    const current = ensureFile();
    if (line.startsWith("--- ")) {
      const path = cleanPatchPath(line.slice(4));
      current.oldPath = path === "/dev/null" ? null : path;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = cleanPatchPath(line.slice(4));
      if (path !== "/dev/null") current.path = path;
      else if (current.oldPath) current.path = current.oldPath;
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ type: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push({ type: "add", text: line.slice(1), oldLine: null, newLine });
      current.adds++;
      if (newLine !== null) newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.lines.push({ type: "del", text: line.slice(1), oldLine, newLine: null });
      current.dels++;
      if (oldLine !== null) oldLine++;
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "ctx", text: line.slice(1), oldLine, newLine });
      if (oldLine !== null) oldLine++;
      if (newLine !== null) newLine++;
    } else {
      current.lines.push({ type: "meta", text: line, oldLine: null, newLine: null });
    }
  }

  return { files, omitted: allLines.length - source.length };
}

function appendCommitLine(parent: HTMLElement, line: CommitLine): void {
  const row = document.createElement("div");
  row.className = `commit-diff-line ${line.type}`;

  if (line.type === "hunk" || line.type === "meta") {
    const text = document.createElement("span");
    text.className = "commit-line-wide";
    text.textContent = line.text;
    row.append(text);
  } else {
    const oldNo = document.createElement("span");
    oldNo.className = "commit-line-no old";
    oldNo.textContent = line.oldLine === null ? "" : String(line.oldLine);
    const newNo = document.createElement("span");
    newNo.className = "commit-line-no new";
    newNo.textContent = line.newLine === null ? "" : String(line.newLine);
    const mark = document.createElement("span");
    mark.className = "commit-line-mark";
    mark.textContent = line.type === "add" ? "+" : line.type === "del" ? "−" : "";
    const code = document.createElement("span");
    code.className = "commit-line-code";
    code.textContent = line.text || " ";
    row.append(oldNo, newNo, mark, code);
  }
  parent.append(row);
}

/** 複数ファイルの差分は一覧と行番号付きのファイル別パッチにして表示する。 */
function renderMultiFileDiffBody(d: CommitDiff, labels: MultiFileLabels): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "commit-diff";
  const parsed = parseCommitPatch(d.patch);
  if (parsed.files.length === 0) {
    appendLine(body, "empty", labels.noDiff);
    return body;
  }

  const nav = document.createElement("nav");
  nav.className = "commit-file-nav";
  nav.setAttribute("aria-label", labels.fileList);
  const navTitle = document.createElement("div");
  navTitle.className = "commit-file-nav-title";
  navTitle.textContent = labels.files(parsed.files.length);
  const navList = document.createElement("div");
  navList.className = "commit-file-nav-list";
  nav.append(navTitle, navList);

  const patches = document.createElement("div");
  patches.className = "commit-patches";
  const navButtons: HTMLButtonElement[] = [];
  const sections: HTMLElement[] = [];
  let activeIndex = -1;
  let truncatedNote: HTMLDivElement | null = null;

  const activateFile = (index: number): void => {
    if (index === activeIndex) return;
    activeIndex = index;
    navButtons.forEach((button, i) => {
      const active = i === index;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
    navButtons[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    patches.replaceChildren(sections[index]);
    if (truncatedNote) patches.append(truncatedNote);
    patches.scrollTo({ top: 0, left: 0 });
  };

  parsed.files.forEach((current, index) => {
    const navButton = document.createElement("button");
    navButton.type = "button";
    navButton.className = "commit-file-nav-item";
    navButton.title = current.path;
    const navPath = document.createElement("span");
    navPath.className = "commit-file-nav-path";
    navPath.textContent = current.path;
    const navStats = document.createElement("span");
    navStats.className = "commit-file-nav-stats";
    const navAdds = document.createElement("span");
    navAdds.className = "agent-file-adds";
    navAdds.textContent = `+${current.adds}`;
    const navDels = document.createElement("span");
    navDels.className = "agent-file-dels";
    navDels.textContent = `−${current.dels}`;
    navStats.append(navAdds, navDels);
    navButton.append(navPath, navStats);
    navList.append(navButton);
    navButtons.push(navButton);

    const section = document.createElement("section");
    section.className = "commit-file";
    const head = document.createElement("div");
    head.className = "commit-file-head";
    const path = document.createElement("span");
    path.className = "commit-file-path";
    path.textContent = current.path;
    path.title = current.path;
    const stats = navStats.cloneNode(true);
    head.append(path, stats);
    if (current.oldPath && current.oldPath !== current.path) {
      const renamed = document.createElement("span");
      renamed.className = "commit-file-old-path";
      renamed.textContent = `← ${current.oldPath}`;
      renamed.title = current.oldPath;
      head.append(renamed);
    }
    const code = document.createElement("div");
    code.className = "commit-file-code";
    for (const line of current.lines) appendCommitLine(code, line);
    section.append(head, code);
    sections.push(section);

    navButton.onclick = () => activateFile(index);
  });

  if (parsed.omitted > 0 || d.truncated) {
    const note = document.createElement("div");
    note.className = "commit-diff-truncated";
    if (parsed.omitted > 0) note.append(t("agent.diffTruncated", { n: String(parsed.omitted) }));
    if (d.truncated) {
      if (note.childNodes.length) note.append(document.createElement("br"));
      note.append(labels.truncated);
    }
    truncatedNote = note;
  }

  activateFile(0);
  body.append(nav, patches);
  return body;
}

function setHeader(title: string, adds: number, dels: number, commit: boolean): void {
  diffPathEl.textContent = title;
  diffPathEl.title = title;
  diffPathEl.classList.toggle("commit-title", commit);
  diffPanel.classList.toggle("is-commit", commit);
  diffBodyEl.classList.toggle("is-commit", commit);
  diffStatsEl.innerHTML = "";
  const plus = document.createElement("span");
  plus.className = "agent-file-adds";
  plus.textContent = `+${adds}`;
  const minus = document.createElement("span");
  minus.className = "agent-file-dels";
  minus.textContent = `-${dels}`;
  diffStatsEl.append(plus, minus);
}

export function openFileDiffOverlay(d: FileDiff, adds: number, dels: number): void {
  setHeader(d.path, adds, dels, false);
  diffBodyEl.innerHTML = "";
  diffBodyEl.append(renderFileDiffBody(d));
  diffOverlay.hidden = false;
}

export function openCommitDiffOverlay(title: string, d: CommitDiff): void {
  setHeader(title, d.adds, d.dels, true);
  diffBodyEl.innerHTML = "";
  diffBodyEl.append(renderMultiFileDiffBody(d, {
    noDiff: t("git.commitNoDiff"),
    files: (count) => t("git.commitFiles", { n: String(count) }),
    fileList: t("git.commitFileList"),
    truncated: t("git.commitDiffTruncated"),
  }));
  diffOverlay.hidden = false;
}

export function openWorktreeDiffOverlay(d: CommitDiff): void {
  setHeader(t("agent.allChangesTitle"), d.adds, d.dels, true);
  diffBodyEl.innerHTML = "";
  diffBodyEl.append(renderMultiFileDiffBody(d, {
    noDiff: t("agent.noChangesDiff"),
    files: (count) => t("agent.changedFiles", { n: String(count) }),
    fileList: t("agent.changedFileList"),
    truncated: t("agent.changesDiffTruncated"),
  }));
  diffOverlay.hidden = false;
}

/** PR 詳細内でもコミット差分と同じファイルナビ + 行番号付きパッチを使う。 */
export function renderPullRequestDiffBody(d: CommitDiff): HTMLDivElement {
  return renderMultiFileDiffBody(d, {
    noDiff: t("git.prNoDiff"),
    files: (count) => t("git.prDiffFiles", { n: String(count) }),
    fileList: t("git.prDiffFileList"),
    truncated: t("git.prDiffTruncated"),
  });
}

function closeDiffOverlay(): void {
  diffOverlay.hidden = true;
}

diffCloseBtn.onclick = closeDiffOverlay;
diffOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === diffOverlay) closeDiffOverlay();
});
diffPanel.addEventListener("keydown", (e) => e.stopPropagation());
window.addEventListener(
  "keydown",
  (e) => {
    if (!diffOverlay.hidden && e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      closeDiffOverlay();
    }
  },
  true,
);
