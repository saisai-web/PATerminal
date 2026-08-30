export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 履歴の引き継ぎ（features/agents/takeover.ts、#history-overlay）
// - 一覧は1つだけ: agent_session_list の結果から不正 ID・未知エージェントを落として表示
// - 開く: 行の下に作成先パスの確認（手入力 + 「参照…」のフォルダ選択）を展開してから
//   新規セッション + 再開コマンド
// - 実行中の会話は同じ一覧の中でバッジ + 「表示」ボタン + 展開内の二重プロセス警告
// - 由来: 稼働中 / 最近削除したセッションと sessionId で照合して名前とグループを表示
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  window.__mockAgentSessionList = [
    { kind: "claude", id: "aaaaaaaa-1111-4111-8111-111111111111", cwd: "/home/user/proj",
      summary: "fix the login bug", updatedMs: Date.now() - 300_000 },
    { kind: "codex", id: "bbbbbbbb-2222-7222-8222-222222222222", cwd: "/home/user",
      summary: null, updatedMs: Date.now() - 3_600_000 },
    // 不正な ID と未知のエージェントはフロント側の検証でも落とす
    { kind: "claude", id: "df816fd0; rm -rf /", cwd: "/home/user",
      summary: "malicious", updatedMs: Date.now() },
    { kind: "unknown-agent", id: "cccccccc-3333-4333-8333-333333333333", cwd: "/home/user",
      summary: "unknown", updatedMs: Date.now() },
  ];
});
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(300);

// ---- 一覧の表示 ----
check("history is in the focused pane header, auto-enter is in the toolbar",
  await page.locator(".pane.is-focused .pane-bar #session-trash-open").isVisible() &&
    (await page.locator(".pane.is-focused .pane-bar #auto-enter-toggle").count()) === 0 &&
    await page.locator("#toolbar #auto-enter-toggle").isVisible());
const toolbarOrder = await page.locator("#toolbar > *").evaluateAll(
  (els) => els.map((el) => el.id || el.className),
);
check("auto-enter sits directly to the right of the takeover history button",
  toolbarOrder.indexOf("auto-enter-toggle") === toolbarOrder.indexOf("takeover-open") + 1,
  `order=${JSON.stringify(toolbarOrder)}`);
await page.locator("#takeover-open").click();
check("toolbar button opens the takeover modal",
  await page.locator("#takeover-panel").isVisible());
check("toolbar history opens the shared dialog on the conversation tab",
  (await page.locator("#history-tab-takeover").getAttribute("aria-selected")) === "true" &&
    await page.locator("#session-trash-panel").isHidden());
check("the toolbar button is labeled 履歴",
  (await page.locator("#takeover-open").textContent()) === "履歴");
check("the modal is titled 履歴から引き継ぐ",
  (await page.locator("#history-title").textContent()) === "履歴から引き継ぐ");
check("the modal has a single unified list (no running section)",
  (await page.locator("#takeover-running").count()) === 0 &&
    (await page.locator(".takeover-section-head").count()) === 0);
await page.waitForSelector("#takeover-history .takeover-row", { timeout: 5000 });
const rows = page.locator("#takeover-history .takeover-row");
check("history lists only valid known-agent conversations", (await rows.count()) === 2,
  String(await rows.count()));
await page.locator("#history-tab-trash").click();
check("the toolbar entry also exposes the recently-deleted tab",
  (await page.locator("#history-tab-trash").getAttribute("aria-selected")) === "true" &&
    await page.locator("#session-trash-panel").isVisible());
await page.locator("#history-tab-takeover").click();
check("switching back reuses the conversation scan within the same dialog",
  (await page.locator("#takeover-history .takeover-row").count()) === 2 &&
    (await page.evaluate(() => (window.__agentSessionListCalls ?? []).length)) === 1);
check("a history row shows the conversation summary",
  (await rows.nth(0).locator(".takeover-name").textContent()) === "fix the login bug");
check("a summary-less row shows the placeholder",
  (await rows.nth(1).locator(".takeover-name").textContent()) === "（メッセージなし）");
check("a history row shows the conversation directory (last 2 segments, full path in title)",
  (await rows.nth(0).locator(".takeover-cwd").textContent()) === ".../user/proj" &&
    (await rows.nth(0).locator(".takeover-cwd").getAttribute("title")) === "/home/user/proj");
check("an external conversation has no origin line and no show button",
  (await rows.nth(0).locator(".takeover-origin").count()) === 0 &&
    (await rows.nth(0).locator(".takeover-show").count()) === 0);

// ---- 作成先パスの展開 ----
await rows.nth(0).locator(".takeover-open-btn").click();
const confirm0 = rows.nth(0).locator(".takeover-confirm");
check("clicking open expands the destination confirmation",
  await confirm0.isVisible());
check("the destination input is prefilled with the conversation cwd",
  (await confirm0.locator("input").inputValue()) === "/home/user/proj");
check("a non-running conversation shows no duplicate-process warning",
  (await confirm0.locator(".takeover-warning").count()) === 0);

// キャンセルで展開だけ閉じる（モーダルは開いたまま）
await confirm0.locator(".takeover-confirm-actions button:not(.is-primary)").click();
check("cancel closes the confirmation but keeps the modal open",
  (await rows.nth(0).locator(".takeover-confirm").count()) === 0 &&
    await page.locator("#takeover-panel").isVisible());

// 別の行の展開を開くと、先に開いた展開は閉じる
await rows.nth(0).locator(".takeover-open-btn").click();
await rows.nth(1).locator(".takeover-open-btn").click();
check("opening another row's confirmation closes the previous one",
  (await rows.nth(0).locator(".takeover-confirm").count()) === 0 &&
    (await rows.nth(1).locator(".takeover-confirm").count()) === 1);

// 「参照…」= OS のフォルダ選択ダイアログで作成先を選ぶ
await page.evaluate(() => { window.__mockPickedDirectory = "/tmp/picked-dir"; });
await rows.nth(1).locator(".takeover-browse").click();
await page.waitForTimeout(100);
check("browse opens the folder dialog and fills the destination input",
  (await rows.nth(1).locator(".takeover-confirm input").inputValue()) === "/tmp/picked-dir" &&
    (await page.evaluate(() => (window.__dialogOpenCalls ?? []).length)) === 1);
// ダイアログのキャンセル（null）では値を変えない
await page.evaluate(() => { window.__mockPickedDirectory = null; });
await rows.nth(1).locator(".takeover-browse").click();
await page.waitForTimeout(100);
check("cancelling the folder dialog keeps the current input value",
  (await rows.nth(1).locator(".takeover-confirm input").inputValue()) === "/tmp/picked-dir");

// 選んだフォルダで開く → そのパスで新規セッション + 再開コマンド自動入力
const spawnsBefore = await page.evaluate(() => window.__ptySpawns.length);
await rows.nth(1).locator(".takeover-confirm .is-primary").click();
await page.waitForTimeout(800); // run コマンドは spawn の 400ms 後に入力される
check("opening a conversation closes the modal",
  await page.locator("#history-overlay").isHidden());
const spawn = await page.evaluate((n) => window.__ptySpawns[n] ?? null, spawnsBefore);
check("the new session opens at the browsed destination path",
  spawn?.cwd === "/tmp/picked-dir", JSON.stringify(spawn));
const resumeWrites = await page.evaluate(
  (id) => window.__ptyWrites.filter((w) => w.id === id).map((w) => w.data).join(""),
  spawn.id,
);
check("the resume command is typed into the new session",
  resumeWrites.includes("codex resume bbbbbbbb-2222-7222-8222-222222222222\r"));

// パスを手で編集して開く（claude の行）
await page.locator("#takeover-open").click();
await page.waitForSelector("#takeover-history .takeover-row", { timeout: 5000 });
await rows.nth(0).locator(".takeover-open-btn").click();
await rows.nth(0).locator(".takeover-confirm input").fill("/home/user");
const spawns2Before = await page.evaluate(() => window.__ptySpawns.length);
await rows.nth(0).locator(".takeover-confirm .is-primary").click();
await page.waitForTimeout(800);
const spawn2 = await page.evaluate((n) => window.__ptySpawns[n] ?? null, spawns2Before);
check("the new session opens at the manually edited path",
  spawn2?.cwd === "/home/user", JSON.stringify(spawn2));
const resumeWrites2 = await page.evaluate(
  (id) => window.__ptyWrites.filter((w) => w.id === id).map((w) => w.data).join(""),
  spawn2.id,
);
check("the manually pathed session resumes the claude conversation",
  resumeWrites2.includes("claude --resume aaaaaaaa-1111-4111-8111-111111111111\r"));
check("the new session is named after the summary",
  (await page.locator(".ws-name").allTextContents()).some((t) => t.startsWith("fix the login")));

// ---- 実行中の会話（同じ一覧内のバッジ + 表示 + 警告） ----
// 最初のペインで claude が動いている状態を作る（26-agents.mjs と同じスイープ駆動）
const firstPaneId = await page.evaluate(() => window.__ptySpawns[0].id);
await page.evaluate((id) => {
  window.__mockPtyAgents = { [id]: "claude" };
  window.__mockAgentSessionId = "aaaaaaaa-1111-4111-8111-111111111111";
}, firstPaneId);
const runSweep = async () => {
  const before = await page.evaluate(() => (window.__ptyAgentCalls ?? []).length);
  for (let i = 0; i < 20; i++) {
    await page.evaluate(
      (id) => window.__emit("pty:act", { id, busy: false, busyMs: 100, waiting: false }),
      firstPaneId,
    );
    await page.waitForTimeout(400);
    const now = await page.evaluate(() => (window.__ptyAgentCalls ?? []).length);
    if (now > before) return true;
  }
  return false;
};
check("sweep detects the running agent", await runSweep());
// スイープ後の agent_session_id 解決（spec.agent.sessionId）が保存に載るまで待つ
await page.waitForFunction(() => {
  const saved = window.__savedSession ? JSON.parse(window.__savedSession) : null;
  return saved?.workspaces?.some(
    (w) => w.root?.agent?.sessionId === "aaaaaaaa-1111-4111-8111-111111111111",
  );
}, undefined, { timeout: 8000 });

const activeWsId = () =>
  page.evaluate(() => document.querySelector(".ws-item.is-active")?.dataset.wsId ?? null);
const firstWsId = await page.evaluate(
  () => document.querySelector(".ws-item")?.dataset.wsId ?? null,
);
await page.locator("#takeover-open").click();
await page.waitForSelector("#takeover-history .takeover-row", { timeout: 5000 });
check("the running conversation shows its badge in the unified list",
  (await rows.nth(0).locator(".takeover-running-badge").count()) === 1);
check("the running conversation shows its origin session",
  (await rows.nth(0).locator(".takeover-origin-name").textContent()) === "セッション: Session 1");
check("only the running row has a show button",
  (await rows.nth(0).locator(".takeover-show").count()) === 1 &&
    (await rows.nth(1).locator(".takeover-show").count()) === 0);

// 「表示」= 会話が動いているセッションへ移動
check("another session is active before jumping", (await activeWsId()) !== firstWsId);
await rows.nth(0).locator(".takeover-show").click();
await page.waitForTimeout(200);
check("show jumps to the running conversation's session",
  (await activeWsId()) === firstWsId &&
    await page.locator("#history-overlay").isHidden());

// 実行中の会話の展開には二重プロセスの警告が出て、確認してから開ける
await page.locator("#takeover-open").click();
await page.waitForSelector("#takeover-history .takeover-row", { timeout: 5000 });
const sessionsBefore = await page.locator(".ws-item").count();
await rows.nth(0).locator(".takeover-open-btn").click();
const runningConfirm = rows.nth(0).locator(".takeover-confirm");
check("taking over a running conversation shows the duplicate-process warning",
  await runningConfirm.locator(".takeover-warning").isVisible() &&
    (await runningConfirm.locator(".takeover-warning").textContent()) ===
      "この会話は別のペインで実行中です。ここで開くと同じ会話が二重に動きます。" &&
    (await page.locator(".ws-item").count()) === sessionsBefore);
const spawns3Before = await page.evaluate(() => window.__ptySpawns.length);
await runningConfirm.locator(".is-primary").click();
await page.waitForTimeout(800);
check("confirming opens the takeover session",
  (await page.locator(".ws-item").count()) === sessionsBefore + 1 &&
    await page.locator("#history-overlay").isHidden());
const spawn3 = await page.evaluate((n) => window.__ptySpawns[n] ?? null, spawns3Before);
const resumeWrites3 = await page.evaluate(
  (id) => window.__ptyWrites.filter((w) => w.id === id).map((w) => w.data).join(""),
  spawn3.id,
);
check("the takeover session resumes the detected conversation",
  resumeWrites3.includes("claude --resume aaaaaaaa-1111-4111-8111-111111111111\r"));

await page.close();

// ---- 由来: 最近削除したセッション + グループとの照合 ----
const pageOrigin = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageOrigin.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageOrigin.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "w1",
    groups: [
      { id: "g-parent", name: "Team" },
      { id: "g1", name: "MyGroup", parentId: "g-parent" },
    ],
    deletedWorkspaces: [
      { id: "w-old", name: "OldWs", group: "g1", shellKind: "default", broadcast: false,
        deletedAt: Date.now() - 86_400_000,
        root: { kind: "leaf", title: "x",
          agent: { kind: "claude", sessionId: "dddddddd-4444-4444-8444-444444444444" } } },
    ],
    settings: { language: "ja" },
    workspaces: [
      { id: "w1", name: "Live", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
    ],
  });
  window.__mockAgentSessionList = [
    { kind: "claude", id: "dddddddd-4444-4444-8444-444444444444", cwd: "/home/user/proj",
      summary: "old conversation", updatedMs: Date.now() - 7_200_000 },
  ];
});
await pageOrigin.goto(BASE_URL);
await pageOrigin.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageOrigin.locator("#takeover-open").click();
await pageOrigin.waitForSelector("#takeover-history .takeover-row", { timeout: 5000 });
const originRow = pageOrigin.locator("#takeover-history .takeover-row").nth(0);
check("a deleted-session conversation shows its origin with the deleted mark",
  (await originRow.locator(".takeover-origin-name").textContent()) ===
    "セッション: OldWs （削除済み）");
check("the origin line shows the group path including parents",
  (await originRow.locator(".takeover-origin-group").textContent()) ===
    "グループ: Team / MyGroup");
await pageOrigin.close();

// ---- 走査の失敗はエラーメッセージに退化する ----
const pageErr = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageErr.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageErr.addInitScript(() => {
  window.__mockAgentSessionListError = "scan failed (mock)";
});
await pageErr.goto(BASE_URL);
await pageErr.waitForSelector(".pane", { timeout: 10000 });
await pageErr.locator("#takeover-open").click();
await pageErr.waitForFunction(() => {
  const el = document.querySelector("#takeover-history-status");
  return el && !el.hidden && el.classList.contains("is-error");
}, undefined, { timeout: 5000 });
check("a failed scan shows the error status",
  (await pageErr.locator("#takeover-history-status").textContent()) ===
    "保存された会話を読み込めませんでした。");
await pageErr.close();

}
