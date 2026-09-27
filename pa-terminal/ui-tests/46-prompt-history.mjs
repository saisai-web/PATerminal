export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// 入力履歴（features/history/prompt-history.ts、#prompt-history-overlay）
// - 一覧: サイドバーと同じグループ階層。アーカイブ済みは出さない。記録なしは既定で隠す
// - グループを選ぶと配下（サブグループ含む）の全セッションをセッション見出しつきで表示
// - 索引: Workspace.agentHistory（session.json に保存 / 旧データはペインの再開情報から補う）
// - 本文: agent_session_prompts を選んだセッションぶん1回だけ呼ぶ
// - 検索・エージェント絞り込み・コピー・ターミナルへ入力（Enter なし）
// - 実行検知で解決した会話 ID が索引へ追記され、保存される
// ============================================================

const CLAUDE_OLD = "aaaaaaaa-1111-4111-8111-111111111111";
const CODEX_NEW = "bbbbbbbb-2222-7222-8222-222222222222";
const LEGACY = "cccccccc-3333-4333-8333-333333333333";
const MISSING = "dddddddd-4444-4444-8444-444444444444";
const LIVE = "eeeeeeee-5555-4555-8555-555555555555";
const SUB = "ffffffff-6666-4666-8666-666666666666";
const ARCHIVED = "abababab-7777-4777-8777-777777777777";

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(({ CLAUDE_OLD, CODEX_NEW, LEGACY, MISSING, SUB, ARCHIVED }) => {
  const leaf = (extra = {}) => ({ kind: "leaf", cwd: "/home/user/proj", ...extra });
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "alpha",
    groups: [{ id: "g1", name: "Backend" }, { id: "g2", name: "API", parentId: "g1" }],
    workspaces: [
      { id: "alpha", name: "Alpha", shellKind: "default", broadcast: false, group: "g1",
        backgroundColor: "green",
        agentHistory: [
          { kind: "claude", sessionId: CLAUDE_OLD, seenAt: Date.now() - 7_200_000 },
          { kind: "codex", sessionId: CODEX_NEW, seenAt: Date.now() - 600_000 },
          // 手編集等の不正値は復元時に落とす
          { kind: "claude", sessionId: "bad; rm -rf /", seenAt: 1 },
          { kind: "other", sessionId: MISSING, seenAt: 1 },
        ],
        root: leaf() },
      // 記録機能より前のデータ: ペインの再開情報から索引を補う
      { id: "beta", name: "Beta", shellKind: "default", broadcast: false,
        root: leaf({ agent: { kind: "claude", sessionId: LEGACY } }) },
      { id: "gamma", name: "Gamma", shellKind: "default", broadcast: false,
        agentHistory: [{ kind: "claude", sessionId: MISSING, seenAt: Date.now() }],
        root: leaf() },
      { id: "delta", name: "Delta", shellKind: "default", broadcast: false, root: leaf() },
      { id: "sub", name: "Sub", shellKind: "default", broadcast: false, group: "g2",
        agentHistory: [{ kind: "claude", sessionId: SUB, seenAt: Date.now() }], root: leaf() },
      // アーカイブ済みは入力履歴の対象外（グループ内でも数えない）
      { id: "arch", name: "Archived", shellKind: "default", broadcast: false, group: "g1", archived: true,
        agentHistory: [{ kind: "claude", sessionId: ARCHIVED, seenAt: Date.now() }], root: leaf() },
    ],
  });
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  window.__mockAgentPrompts = {
    [CLAUDE_OLD]: [
      { text: "ログイン画面のバグを直して", timestamp: at(120), images: 0, command: false },
      { text: "/model opus", timestamp: at(118), images: 0, command: true },
      { text: "テストも追加して\n境界値も確認して", timestamp: at(110), images: 2, command: false },
    ],
    [CODEX_NEW]: [
      { text: "README を更新して", timestamp: at(10), images: 0, command: false },
    ],
    [LEGACY]: [{ text: "legacy prompt", timestamp: null, images: 0, command: false }],
    [SUB]: [{ text: "sub prompt", timestamp: null, images: 0, command: false }],
    [ARCHIVED]: [{ text: "archived prompt", timestamp: null, images: 0, command: false }],
  };
}, { CLAUDE_OLD, CODEX_NEW, LEGACY, MISSING, SUB, ARCHIVED });
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(400);

const open = page.locator("#prompt-history-open");
check("prompt history toolbar button has an accessible label",
  (await open.getAttribute("aria-label")) === "入力履歴" && (await open.textContent()).trim() === "入力履歴");
await open.click();
const overlay = page.locator("#prompt-history-overlay");
check("toolbar button opens the prompt history dialog", await overlay.isVisible());
check("toolbar button reports the dialog as expanded",
  (await open.getAttribute("aria-expanded")) === "true");
await page.waitForSelector(".ph-conv");

// ---- セッション一覧（グループ階層） ----
const navOrder = () => page.locator(".ph-nav-item").evaluateAll((els) => els.map((el) => el.dataset.sel));
const nav = await navOrder();
check("the list follows the sidebar's group tree",
  JSON.stringify(nav) === JSON.stringify(["ws:beta", "ws:gamma", "group:g1", "ws:alpha", "group:g2", "ws:sub"]),
  nav.join(","));
check("archived sessions are not listed",
  (await page.locator('.ph-session[data-ws-id="arch"]').count()) === 0);
check("sessions without records are hidden by default",
  (await page.locator('.ph-session[data-ws-id="delta"]').count()) === 0);
check("group headers count only listed sessions' conversations",
  (await page.locator('.ph-group-head[data-group-id="g1"] .ph-session-count').textContent()) === "3");
check("nested groups are indented",
  await page.locator('.ph-group-head[data-group-id="g2"]').evaluate((el) => el.style.getPropertyValue("--ph-depth")) === "1");
check("the active session is selected when opened from the toolbar",
  (await page.locator('.ph-session[data-ws-id="alpha"]').getAttribute("aria-selected")) === "true");
check("the active session is marked as current",
  (await page.locator('.ph-session[data-ws-id="alpha"] .ph-session-current').count()) === 1);
check("invalid saved references are dropped on restore",
  (await page.locator('.ph-session[data-ws-id="alpha"] .ph-session-count').textContent()) === "2");
await page.locator(".ph-nav-toggle").click();
check("the toggle reveals sessions without records",
  await page.locator('.ph-session[data-ws-id="delta"]').evaluate((el) => el.classList.contains("is-empty")) &&
    (await page.locator('.ph-session[data-ws-id="arch"]').count()) === 0);
await page.locator(".ph-nav-toggle").click();
check("only the selected session's conversations are read, in one call",
  await page.evaluate(({ CLAUDE_OLD, CODEX_NEW }) => {
    const calls = window.__agentPromptCalls ?? [];
    return calls.length === 1 && calls[0].map((r) => r.id).join() === [CLAUDE_OLD, CODEX_NEW].join();
  }, { CLAUDE_OLD, CODEX_NEW }));

// ---- タイムライン ----
const convs = page.locator(".ph-conv");
check("conversations are listed newest first",
  JSON.stringify(await convs.evaluateAll((els) => els.map((el) => el.dataset.kind))) ===
    JSON.stringify(["codex", "claude"]));
check("summary shows prompt and conversation counts",
  (await page.locator(".ph-stat").allTextContents()).join("|") === "4 件の入力|2 件の会話");
check("the first real prompt titles the conversation",
  (await page.locator('.ph-conv[data-kind="claude"] .ph-conv-title').textContent()) === "ログイン画面のバグを直して");
const claudeTexts = await page.locator('.ph-conv[data-kind="claude"] .ph-text').allTextContents();
check("prompts are shown in the order they were sent",
  claudeTexts.join("|") === "ログイン画面のバグを直して|/model opus|テストも追加して\n境界値も確認して");
check("slash commands are tagged",
  (await page.locator('.ph-conv[data-kind="claude"] .ph-prompt.is-command').count()) === 1);
check("attached image counts are shown",
  (await page.locator('.ph-conv[data-kind="claude"] .ph-images').textContent()).trim() === "2");
check("prompt times are rendered as <time>",
  (await page.locator('.ph-conv[data-kind="claude"] time.ph-time').count()) === 3);

// ---- エージェント絞り込み ----
await page.locator('.ph-filter-btn[data-kind="codex"]').click();
check("agent filter shows only that agent's conversations",
  (await convs.count()) === 1 && (await convs.first().getAttribute("data-kind")) === "codex");
await page.locator(".ph-filter-btn").first().click();
check("the All filter restores every conversation", (await convs.count()) === 2);

// ---- 検索 ----
await page.fill("#prompt-history-search", "テスト");
check("search keeps only matching prompts",
  (await page.locator(".ph-prompt").count()) === 1 && (await convs.count()) === 1);
check("search highlights the match", (await page.locator(".ph-text mark").textContent()) === "テスト");
check("search reports the number of hits", (await page.locator(".ph-hits").textContent()) === "1 件が一致");
await page.fill("#prompt-history-search", "存在しない語");
check("an empty search result explains itself",
  (await page.locator(".ph-empty-title").textContent()) === "検索に一致する入力はありません。");
await page.locator("#prompt-history-search").press("Escape");
check("Escape in a filled search box clears it without closing",
  await overlay.isVisible() && (await page.inputValue("#prompt-history-search")) === "" &&
    (await page.locator(".ph-prompt").count()) === 4);

// ---- 折りたたみ ----
await page.locator('.ph-conv[data-kind="claude"] .ph-conv-head').click();
check("clicking a conversation header collapses it",
  await page.locator('.ph-conv[data-kind="claude"]').evaluate((el) => el.classList.contains("is-collapsed")) &&
    (await page.locator('.ph-conv[data-kind="claude"] .ph-conv-toggle').getAttribute("aria-expanded")) === "false");
await page.locator('.ph-conv[data-kind="claude"] .ph-conv-head').click();

// ---- グループ表示 ----
await page.locator('.ph-group-head[data-group-id="g1"]').click();
await page.waitForSelector(".ph-session-divider");
const dividers = await page.locator(".ph-session-divider").evaluateAll((els) => els.map((el) => el.dataset.wsId));
check("selecting a group shows every listed session in it, including subgroups",
  JSON.stringify(dividers) === JSON.stringify(["alpha", "sub"]), dividers.join(","));
check("the group view excludes archived sessions",
  !(await page.locator("#prompt-history-timeline").textContent()).includes("archived prompt"));
check("subgroup sessions show their relative group path",
  (await page.locator('.ph-session-divider[data-ws-id="sub"] .ph-divider-path').textContent()) === "API");
check("the group summary counts conversations across sessions",
  (await page.locator(".ph-stat").allTextContents()).join("|") === "5 件の入力|3 件の会話");
await page.locator('.ph-group-head[data-group-id="g2"] .ph-group-chevron').click();
check("group chevron collapses the group in the list",
  (await page.locator('.ph-session[data-ws-id="sub"]').isHidden()) &&
    (await page.locator('.ph-group-head[data-group-id="g2"]').getAttribute("aria-expanded")) === "false");
await page.locator('.ph-group-head[data-group-id="g2"] .ph-group-chevron').click();
await page.locator('.ph-session-divider[data-ws-id="sub"]').click();
check("a session heading in the group view opens that session alone",
  (await page.locator('.ph-session[data-ws-id="sub"]').getAttribute("aria-selected")) === "true" &&
    (await page.locator(".ph-session-divider").count()) === 0);

// ---- 別セッション ----
await page.locator('.ph-session[data-ws-id="beta"]').click();
await page.waitForSelector('.ph-conv[data-session-id="' + LEGACY + '"]');
check("legacy pane agent info seeds the session's history",
  (await page.locator(".ph-text").textContent()) === "legacy prompt");
await page.locator('.ph-session[data-ws-id="beta"]').press("ArrowDown");  // beta → gamma
await page.waitForSelector(".ph-conv .ph-note");
check("arrow keys move between sessions",
  (await page.locator('.ph-session[data-ws-id="gamma"]').getAttribute("aria-selected")) === "true");
check("a conversation whose file is gone says so",
  (await page.locator(".ph-conv .ph-note").textContent()).includes("見つかりません"));
await page.locator(".ph-nav-toggle").click();
await page.locator('.ph-session[data-ws-id="delta"]').click();
check("a session without records shows the empty state",
  (await page.locator(".ph-empty-title").textContent()) === "まだ入力が記録されていません");

// ---- コピー / ターミナルへ入力 ----
await page.locator('.ph-session[data-ws-id="alpha"]').click();
await page.waitForSelector('.ph-conv[data-kind="claude"]');
const multiline = page.locator('.ph-conv[data-kind="claude"] .ph-prompt').nth(2);
await multiline.hover();
await multiline.locator(".ph-copy").click();
check("copy gives visual confirmation",
  await multiline.locator(".ph-copy").evaluate((el) => el.classList.contains("is-done")));
const alphaPane = await page.evaluate(async () => {
  const { workspaces } = await import("/src/workspace/state.ts");
  const ws = workspaces.find((w) => w.id === "alpha");
  const pane = [...ws.panes.values()][0];
  pane.bracketedPaste = true;
  return pane.id;
});
const before = await page.evaluate(() => window.__ptyWrites.length);
await multiline.locator(".ph-insert").click();
await page.waitForFunction((n) => window.__ptyWrites.length > n, before);
const sent = await page.evaluate(({ n, id }) =>
  window.__ptyWrites.slice(n).filter((w) => w.id === id).map((w) => w.data).join(""), { n: before, id: alphaPane });
check("insert types the prompt as a bracketed paste without Enter",
  sent === "\x1b[200~テストも追加して\r境界値も確認して\x1b[201~", JSON.stringify(sent));
check("insert closes the dialog", await overlay.isHidden());

// ---- サイドバーの右クリックから開く ----
await page.locator('.ws-item[data-ws-id="gamma"]').click({ button: "right" });
const menuItem = page.locator("#ctx-menu button", { hasText: "入力履歴を表示…" });
check("session context menu offers prompt history", (await menuItem.count()) === 1);
await menuItem.click();
check("context menu opens the dialog on that session",
  await overlay.isVisible() &&
    (await page.locator('.ph-session[data-ws-id="gamma"]').getAttribute("aria-selected")) === "true");
await page.keyboard.press("Escape");
check("Escape closes the dialog", await overlay.isHidden());
check("the context menu of an archived session does not offer prompt history",
  await page.evaluate(async () => {
    const { workspaces } = await import("/src/workspace/state.ts");
    const { openGroupMenu } = await import("/src/features/sidebar/sidebar-menu.ts");
    const ws = workspaces.find((w) => w.id === "arch");
    openGroupMenu(ws, 40, 40, document.createElement("span"));
    const found = [...document.querySelectorAll("#ctx-menu button")].some((b) => b.textContent === "入力履歴を表示…");
    document.querySelector("#ctx-menu")?.remove();
    return !found;
  }));

// ---- 実行検知からの記録と保存 ----
await page.evaluate(({ id, LIVE }) => {
  window.__mockPtyAgents = { [id]: "claude" };
  window.__mockAgentSessionId = LIVE;
}, { id: alphaPane, LIVE });
// 検知スイープは5秒間隔。async 述語は waitForFunction だと即 truthy になるため自前で待つ
let recorded = false;
for (let i = 0; i < 30 && !recorded; i++) {
  await page.waitForTimeout(500);
  recorded = await page.evaluate(async (LIVE) => {
    const { workspaces } = await import("/src/workspace/state.ts");
    return !!workspaces.find((w) => w.id === "alpha").agentHistory?.some((r) => r.sessionId === LIVE);
  }, LIVE);
}
check("a resolved running conversation is added to the session's history", recorded);
await page.evaluate(async () => {
  const { flushSessionSave } = await import("/src/app/session.ts");
  await flushSessionSave();
});
const savedHistory = await page.evaluate(() => {
  const data = JSON.parse(window.__savedSession ?? "{}");
  return data.workspaces?.find((w) => w.id === "alpha")?.agentHistory?.map((r) => r.sessionId) ?? [];
});
check("the session's conversation history is saved to session.json",
  JSON.stringify(savedHistory) === JSON.stringify([CLAUDE_OLD, CODEX_NEW, LIVE]), savedHistory.join(","));
await open.click();
await page.waitForSelector(`.ph-conv[data-session-id="${LIVE}"]`);
check("the running conversation shows a live badge",
  (await page.locator(`.ph-conv[data-session-id="${LIVE}"] .ph-live`).count()) === 1);
await page.keyboard.press("Escape");

check("no page errors", errors.length === 0, errors.join(" / "));
await page.close();
}
