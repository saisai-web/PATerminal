import { chromium } from "playwright";
import { results, check, MOD, BASE_URL, TEST_LOCALE, TEST_OS } from "./ui-tests/context.mjs";
import panes from "./ui-tests/01-panes.mjs";
import sidebar from "./ui-tests/02-sidebar.mjs";
import groups from "./ui-tests/03-groups.mjs";
import dnd from "./ui-tests/04-dnd.mjs";
import selection from "./ui-tests/05-selection.mjs";
import inlineRename from "./ui-tests/06-inline-rename.mjs";
import explorer from "./ui-tests/07-explorer.mjs";
import quickPhrases from "./ui-tests/08-quick-phrases.mjs";
import restoreV4 from "./ui-tests/09-restore-v4-groups.mjs";
import migrateV2 from "./ui-tests/10-migrate-v2.mjs";
import restoreV3Favorites from "./ui-tests/11-restore-v3-favorites.mjs";
import migrateV1 from "./ui-tests/12-migrate-v1.mjs";
import restoreV3Settings from "./ui-tests/13-restore-v3-settings.mjs";
import quickPhraseScope from "./ui-tests/14-quick-phrase-scope.mjs";
import restoreNoSettings from "./ui-tests/15-restore-no-settings.mjs";
import gitChanges from "./ui-tests/16-git-changes.mjs";
import wsGitBadge from "./ui-tests/17-ws-git-badge.mjs";
import gitActions from "./ui-tests/18-git-actions.mjs";
import gitPanel from "./ui-tests/19-git-panel.mjs";
import lastPane from "./ui-tests/20-last-pane.mjs";
import activity from "./ui-tests/21-activity.mjs";
import sessionTrash from "./ui-tests/22-session-trash.mjs";
import sessionNote from "./ui-tests/23-session-note.mjs";
import sessionSwitch from "./ui-tests/24-session-switch.mjs";
import sessionPin from "./ui-tests/25-session-pin.mjs";
import agents from "./ui-tests/26-agents.mjs";
import agentTakeover from "./ui-tests/28-agent-takeover.mjs";
import pair from "./ui-tests/27-pair.mjs";
import settingsDefaults from "./ui-tests/29-settings-defaults.mjs";
import pairModes from "./ui-tests/29-pair-modes.mjs";
import windowsShellChoice from "./ui-tests/30-windows-shell-choice.mjs";
import windowsShell from "./ui-tests/30-windows-shell.mjs";
import resize from "./ui-tests/31-resize.mjs";
import clipboard from "./ui-tests/32-clipboard.mjs";
import broadcastTargets from "./ui-tests/33-broadcast-targets.mjs";
import licenseLock from "./ui-tests/34-license-lock.mjs";
import licenseUi from "./ui-tests/35-license-ui.mjs";
import terminalRecovery from "./ui-tests/36-terminal-recovery.mjs";
import eula from "./ui-tests/37-eula.mjs";

const mode = process.argv.includes("--smoke") ? "smoke" : "full";
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--smoke");
if (unknownArgs.length) {
  throw new Error(`Unknown UI test argument: ${unknownArgs.join(", ")}`);
}

const sharedSuites = [
  ["panes", panes],
  ["sidebar", sidebar],
  ["groups", groups],
  ["dnd", dnd],
  ["selection", selection],
  ["inline-rename", inlineRename],
  ["explorer", explorer],
  ["quick-phrases", quickPhrases],
];
const independentSuites = [
  ["restore-v4", restoreV4],
  ["migrate-v2", migrateV2],
  ["restore-v3-favorites", restoreV3Favorites],
  ["migrate-v1", migrateV1],
  ["restore-v3-settings", restoreV3Settings],
  ["quick-phrase-scope", quickPhraseScope],
  ["restore-no-settings", restoreNoSettings],
  ["git-changes", gitChanges],
  ["ws-git-badge", wsGitBadge],
  ["git-actions", gitActions],
  ["git-panel", gitPanel],
  ["last-pane", lastPane],
  ["activity", activity],
  ["session-trash", sessionTrash],
  ["session-note", sessionNote],
  ["session-switch", sessionSwitch],
  ["session-pin", sessionPin],
  ["agents", agents],
  ["pair", pair],
  ["pair-modes", pairModes],
  ["agent-takeover", agentTakeover],
  ["settings-defaults", settingsDefaults],
  ["windows-shell-choice", windowsShellChoice],
  ["windows-shell", windowsShell],
  ["resize", resize],
  ["clipboard", clipboard],
  ["broadcast-targets", broadcastTargets],
  ["license-lock", licenseLock],
  ["license-ui", licenseUi],
  ["terminal-recovery", terminalRecovery],
  ["eula", eula],
];

// Push / PR では、基盤・保存形式・Git 監視・通知・主要エージェント機能を
// 45 秒以内（起動込みの hard timeout）で確認する。全スイートは引数なしの
// 実行と定期 CI に残す。ペア関連（27 / 29）は CI ランナーの並列 smoke では
// 予算に収まらないため smoke から外してある（入れると pair だけが上限時点で
// 走り続けて全体が exit 124 になる。main で実測済み）。ペアの検証は全件実行で行う。
const smokeShared = new Set(["panes"]);
const smokeIndependent = new Set([
  "restore-v4",
  "migrate-v2",
  "migrate-v1",
  "git-changes",
  "last-pane",
  "activity",
  "agent-takeover",
  "windows-shell", // 2秒程度。Windows のパス / シェル構文の分岐を毎 push で踏む
  "resize", // PTY サイズのずれは TUI が再起動するまで壊れるので毎 push で見る
  "clipboard", // 貼り付けは xterm のキー処理と綱引きになるので毎 push で押さえる
  "license-lock", // ソフトロックの誤ロック/素通りは商売と信頼の両方を壊すので毎 push で見る
  "terminal-recovery", // 復元表示だけの入力不能ペインは二度と作らない
  "eula", // 同意前にトライアル/sessionを作らない起動ゲートは毎 push で見る
]);

const browser = await chromium.launch({ channel: "chrome", headless: true });
// エクスプローラーのショートカット / パス処理は TEST_OS 相当で動かす。**全スイート**で
// 注入する（独立スイートが素の newPage を使うと host_os だけ macos のまま残り、
// MOD が Control になっている分と食い違う）。個別に別 OS を見たいスイートは
// 自分で addInitScript を足せば後勝ちで上書きできる。
const newTestPage = async (options = {}) => {
  const page = await browser.newPage({ locale: TEST_LOCALE, ...options });
  await page.addInitScript((os) => { window.__mockHostOs = os; }, TEST_OS);
  return page;
};
// 後半スイートの browser.newPage も同じ locale / host OS を使う薄い facade を渡す。
const baseCtx = { browser: { newPage: newTestPage }, check, MOD, BASE_URL };
const newSharedContext = async () => {
  const page = await newTestPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  // 右クリックメニューの「パスをコピー」検証用（コピー & 読み戻し）
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane", { timeout: 10000 });
  await page.waitForTimeout(800);
  return { ...baseCtx, page };
};
const startedAt = performance.now();
const runSuite = async ([name, suite], ctx = baseCtx) => {
  const suiteStartedAt = performance.now();
  console.log(`\nSUITE: ${name}`);
  await suite(ctx);
  console.log(`SUITE DONE: ${name} (${((performance.now() - suiteStartedAt) / 1000).toFixed(2)}s)`);
};

// 共有 page を使うスイート（この順序を絶対に変えない）
const selectedShared = mode === "smoke"
  ? sharedSuites.filter(([name]) => smokeShared.has(name))
  : sharedSuites;
const selectedIndependent = mode === "smoke"
  ? independentSuites.filter(([name]) => smokeIndependent.has(name))
  : independentSuites;

if (mode === "smoke") {
  // 独立スイートはそれぞれ専用 BrowserContext を作るため安全に並列実行できる。
  // 共有 page の起動も同時に開始し、CI の遅い初回ページ表示を待ち時間にしない。
  // EULAは複数localeの初回起動、git-changesは複数のdiff描画を検証するため、互いと他スイートの
  // 5秒UI待機を圧迫しないよう並列組の完了後に実行する（smoke対象と検証内容は維持する）。
  const serialNames = new Set(["git-changes", "eula"]);
  const serialSuites = selectedIndependent.filter(([name]) => serialNames.has(name));
  const parallelSuites = selectedIndependent.filter(([name]) => !serialNames.has(name));
  await Promise.all([
    (async () => {
      const ctx = await newSharedContext();
      for (const suite of selectedShared) await runSuite(suite, ctx);
      await ctx.page.close();
    })(),
    ...parallelSuites.map((suite) => runSuite(suite)),
  ]);
  for (const suite of serialSuites) await runSuite(suite);
} else {
  const ctx = await newSharedContext();
  for (const suite of selectedShared) await runSuite(suite, ctx);
  await ctx.page.close();
  // 全件実行は診断しやすさと従来の安定性を優先して直列のままにする。
  for (const suite of selectedIndependent) await runSuite(suite);
}

await browser.close();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} passed (${mode}, ${((performance.now() - startedAt) / 1000).toFixed(2)}s)`);
process.exit(fails.length ? 1 : 0);
