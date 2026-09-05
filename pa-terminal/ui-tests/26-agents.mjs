export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// エージェントのセッション自動引き継ぎ（features/agents）
// - 復元時: PaneSpec.agent から再開コマンドを自動入力する
// - 実行中: pty_agents の検知結果を spec.agent として保存する
// - 終了時: ペイン内の再開バナー（クリックでコマンド + Enter）
// ============================================================

// ---- 復元時の自動再開（保存済み spec.agent → 再開コマンド） ----
const pageRestore = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageRestore.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageRestore.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "w-claude",
    groups: [],
    deletedWorkspaces: [],
    settings: { language: "ja" },
    workspaces: [
      { id: "w-claude", name: "Claude", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a", agent: { kind: "claude", sessionId: "df816fd0-359e-4780-9a50-5807eb61af4d" } } },
      { id: "w-codex", name: "Codex", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b", agent: { kind: "codex", sessionId: "019ff6a1-a25d-7272-b4c9-a17095fbd278" } } },
      { id: "w-noid", name: "NoId", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c", agent: { kind: "claude" } } },
      { id: "w-bad", name: "Bad", shellKind: "default", broadcast: false,
        // 不正な sessionId（手編集）と未知のエージェントは安全側へ落とす
        root: { kind: "split", dir: "row", ratio: 0.5,
          a: { kind: "leaf", title: "d", agent: { kind: "claude", sessionId: "df816fd0; rm -rf /" } },
          b: { kind: "leaf", title: "e", agent: { kind: "unknown-agent", sessionId: "df816fd0-359e-4780-9a50-5807eb61af4d" } } } },
    ],
  });
});
await pageRestore.goto(BASE_URL);
await pageRestore.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageRestore.waitForTimeout(1000); // 再開コマンドは spawn の 400ms 後に入力される
{
  const spawns = await pageRestore.evaluate(() => window.__ptySpawns.map((s) => s.id));
  const writes = await pageRestore.evaluate(() => window.__ptyWrites);
  const writesFor = (id) => writes.filter((w) => w.id === id).map((w) => w.data).join("");
  const [idClaude, idCodex, idNoId, idBadSession, idUnknown] = spawns;
  check("restore resumes claude with the saved session id",
    writesFor(idClaude).includes("claude --resume df816fd0-359e-4780-9a50-5807eb61af4d\r"));
  check("restore resumes codex with the saved session id",
    writesFor(idCodex).includes("codex --no-alt-screen resume 019ff6a1-a25d-7272-b4c9-a17095fbd278\r"));
  check("restore without a session id falls back to --continue",
    writesFor(idNoId).includes("claude --continue\r"));
  check("restore rejects a malformed session id and falls back to --continue",
    writesFor(idBadSession).includes("claude --continue\r") && !writesFor(idBadSession).includes("rm -rf"));
  check("restore ignores unknown agent kinds",
    !writesFor(idUnknown).includes("unknown-agent") && !writesFor(idUnknown).includes("resume"));
}
await pageRestore.close();

// ---- 実行中の検知 → 保存、終了 → 再開バナー ----
const pageWatch = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageWatch.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageWatch.goto(BASE_URL);
await pageWatch.waitForSelector(".pane", { timeout: 10000 });
await pageWatch.waitForTimeout(300);
{
  const paneId = await pageWatch.evaluate(() => window.__ptySpawns[0].id);
  const emitIdle = () =>
    pageWatch.evaluate((id) => window.__emit("pty:act", { id, busy: false, busyMs: 100, waiting: false }),
      paneId);
  // 検知スイープ（5秒間隔 + idle 契機・1秒の間引き）を1回確実に回す:
  // pty_agents の呼び出し数が増えるまで idle を送り続ける
  const runSweep = async () => {
    const before = await pageWatch.evaluate(() => (window.__ptyAgentCalls ?? []).length);
    for (let i = 0; i < 20; i++) {
      await emitIdle();
      await pageWatch.waitForTimeout(400);
      const now = await pageWatch.evaluate(() => (window.__ptyAgentCalls ?? []).length);
      if (now > before) return true;
    }
    return false;
  };
  const savedRootAgent = () =>
    pageWatch.evaluate(() => {
      const saved = window.__savedSession ? JSON.parse(window.__savedSession) : null;
      return saved?.workspaces?.[0]?.root?.agent ?? null;
    });

  // 短時間だけ観測されたエージェントの終了にはバナーを出さない（--help 等の保険）
  await pageWatch.evaluate((id) => {
    window.__mockPtyAgents = { [id]: "claude" };
    window.__mockAgentSessionId = "aaaaaaaa-1111-4111-8111-222222222222";
  }, paneId);
  check("sweep detects the running agent", await runSweep());
  await pageWatch.evaluate(() => { window.__mockPtyAgents = {}; });
  check("sweep observes the quick exit", await runSweep());
  await pageWatch.waitForTimeout(200);
  check("a short-lived agent exit does not show the resume banner",
    (await pageWatch.locator(".pane-resume").count()) === 0);

  // 再検知 → spec.agent が解決済み sessionId 付きで保存される
  await pageWatch.evaluate((id) => { window.__mockPtyAgents = { [id]: "claude" }; }, paneId);
  check("sweep re-detects the agent", await runSweep());
  await pageWatch.waitForFunction(() => {
    const saved = window.__savedSession ? JSON.parse(window.__savedSession) : null;
    return saved?.workspaces?.[0]?.root?.agent?.sessionId === "aaaaaaaa-1111-4111-8111-222222222222";
  }, undefined, { timeout: 8000 });
  const savedAgent = await savedRootAgent();
  check("a detected running agent is saved with its resolved session id",
    savedAgent?.kind === "claude" && savedAgent?.sessionId === "aaaaaaaa-1111-4111-8111-222222222222",
    JSON.stringify(savedAgent));

  // 3秒以上観測してから終了 → 再開バナー（ja: 「claude が終了しました」）
  await pageWatch.waitForTimeout(3100);
  await pageWatch.evaluate(() => { window.__mockPtyAgents = {}; });
  check("sweep observes the exit", await runSweep());
  await pageWatch.waitForSelector(".pane-resume", { timeout: 3000 });
  check("agent exit shows the resume banner",
    (await pageWatch.locator(".pane-resume-label").textContent()) === "claude が終了しました");
  check("the resume button carries the exact resume command",
    (await pageWatch.locator(".pane-resume-btn").getAttribute("title")) ===
      "claude --resume aaaaaaaa-1111-4111-8111-222222222222");

  // 終了後の保存からは spec.agent が消えている（次回の復元で勝手に再開しない）
  await pageWatch.waitForFunction(() => {
    const saved = window.__savedSession ? JSON.parse(window.__savedSession) : null;
    return (saved?.workspaces?.[0]?.root?.agent ?? null) === null;
  }, undefined, { timeout: 8000 });
  check("an exited agent is removed from the saved session", (await savedRootAgent()) === null);

  // バナーの「再開」クリック = コマンド + Enter を入力してバナーを閉じる
  const writesBefore = await pageWatch.evaluate(() => window.__ptyWrites.length);
  await pageWatch.locator(".pane-resume-btn").click();
  await pageWatch.waitForTimeout(200);
  const clicked = await pageWatch.evaluate((n) =>
    window.__ptyWrites.slice(n).map((w) => w.data).join(""), writesBefore);
  check("clicking resume types the command with Enter and closes the banner",
    clicked.includes("claude --resume aaaaaaaa-1111-4111-8111-222222222222\r") &&
      (await pageWatch.locator(".pane-resume").count()) === 0);
}
await pageWatch.close();

}
