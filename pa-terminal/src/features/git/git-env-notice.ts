// git が「この PC の環境」のせいで動かないときの復旧案内。
//
// git_changes はリポジトリ外と環境エラーを区別して problem を返す（Xcode ライセンス未同意・
// Command Line Tools 不在・git 未導入・safe.directory・Windows の長いパス）。従来はどれも
// 「リポジトリ外」と同じく Git 画面が黙って空になり、原因が分からなかった。
// 復旧コマンドはフォーカス中のターミナルへ「入力するだけ」（sudo のパスワードや内容の確認を
// ユーザーに委ねるため Enter は送らない）。git が動くようになったら自動で閉じる。

import { t } from "../../i18n";
import type { MsgKey } from "../../i18n";
import { copyText } from "../../shared/clipboard";

export type GitProblem = { kind: string; command: string | null };

type NoticeDeps = {
  /** フォーカス中のターミナルへ文字列を入力する（改行は送らない）。入力先が無ければ false */
  insert: (text: string) => boolean;
};

let deps: NoticeDeps = { insert: () => false };

export function initGitEnvNotice(d: NoticeDeps): void {
  deps = d;
}

const MESSAGE_KEYS: Record<string, MsgKey> = {
  xcodeLicense: "gitEnv.xcodeLicense",
  developerTools: "gitEnv.developerTools",
  notInstalled: "gitEnv.notInstalled",
  dubiousOwnership: "gitEnv.dubiousOwnership",
  longPaths: "gitEnv.longPaths",
};

const notice = document.createElement("div");
notice.id = "git-env-notice";
notice.hidden = true;
notice.setAttribute("role", "alert");
const icon = document.createElement("span");
icon.className = "git-toast-icon";
icon.setAttribute("aria-hidden", "true");
icon.textContent = "!";
const content = document.createElement("div");
content.className = "git-toast-content";
const title = document.createElement("strong");
const detail = document.createElement("div");
detail.className = "git-env-detail";
const code = document.createElement("code");
code.className = "git-env-command";
const actions = document.createElement("div");
actions.className = "git-env-actions";
const insertBtn = document.createElement("button");
insertBtn.type = "button";
const copyBtn = document.createElement("button");
copyBtn.type = "button";
actions.append(insertBtn, copyBtn);
content.append(title, detail, code, actions);
const close = document.createElement("button");
close.type = "button";
close.className = "git-env-close";
close.textContent = "×";
notice.append(icon, content, close);
document.body.append(notice);

let current: GitProblem | null = null;
// 閉じた案内は同じ問題が続く間は出し直さない（3秒ポーリングのたびに復活させない）
let dismissedKey: string | null = null;

const keyOf = (p: GitProblem) => `${p.kind}\n${p.command ?? ""}`;

close.onclick = () => {
  if (current) dismissedKey = keyOf(current);
  notice.hidden = true;
};
notice.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Escape") close.click();
});
insertBtn.onclick = () => {
  if (current?.command) deps.insert(current.command);
};
copyBtn.onclick = () => {
  if (!current?.command) return;
  void copyText(current.command).then(() => {
    copyBtn.textContent = t("gitEnv.copied");
    window.setTimeout(() => (copyBtn.textContent = t("gitEnv.copy")), 1500);
  });
};

function render(): void {
  if (!current) return;
  title.textContent = t("gitEnv.title");
  const key = MESSAGE_KEYS[current.kind];
  detail.textContent = key ? t(key) : "";
  code.hidden = !current.command;
  actions.hidden = !current.command;
  code.textContent = current.command ?? "";
  insertBtn.textContent = t("gitEnv.insert");
  insertBtn.title = t("gitEnv.insertTitle");
  copyBtn.textContent = t("gitEnv.copy");
  close.setAttribute("aria-label", t("bc.close"));
}

/** git 監視の結果ごとに呼ぶ。null（git が動いた / リポジトリ外）なら案内を閉じる */
export function renderGitEnvProblem(problem: GitProblem | null): void {
  if (!problem) {
    current = null;
    dismissedKey = null;
    notice.hidden = true;
    return;
  }
  const changed = !current || keyOf(current) !== keyOf(problem);
  current = problem;
  if (keyOf(problem) === dismissedKey) return;
  if (changed || notice.hidden) render();
  notice.hidden = false;
}

/** 言語切替時 */
export function renderGitEnvNoticeTexts(): void {
  if (!notice.hidden) render();
}
