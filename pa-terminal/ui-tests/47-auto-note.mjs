export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// メモ欄の自動入力（features/history/auto-note.ts）
// - メモが空で未編集のセッションは、入力履歴の最初の通常入力がメモになる
//   （入力の無い会話・スラッシュコマンドは飛ばす / 120文字で … 省略 / 1行化）
// - メモがある・一度でも編集した（空へ消した）セッションは触らない
// - 実行中の会話が解決されたら、その最初の入力でメモを埋める
// - 自動入力も noteTouched として保存し、消した後に埋め直さない
// ============================================================

const EMPTY = "aaaaaaaa-1111-4111-8111-111111111111";
const FIRST = "bbbbbbbb-2222-4222-8222-222222222222";
const LATER = "cccccccc-3333-4333-8333-333333333333";
const LONG = "dddddddd-4444-4444-8444-444444444444";
const LIVE = "eeeeeeee-5555-4555-8555-555555555555";
const LONG_TEXT = "あ".repeat(200);

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(({ EMPTY, FIRST, LATER, LONG, LIVE, LONG_TEXT }) => {
  const leaf = () => ({ kind: "leaf", cwd: "/home/user/proj" });
  const ref = (sessionId) => ({ kind: "claude", sessionId, seenAt: Date.now() });
  window.__mockSessionLoad = JSON.stringify({
    version: 5,
    activeId: "live",
    groups: [],
    workspaces: [
      { id: "fill", name: "Fill", shellKind: "default", broadcast: false,
        agentHistory: [ref(EMPTY), ref(FIRST), ref(LATER)], root: leaf() },
      { id: "long", name: "Long", shellKind: "default", broadcast: false,
        agentHistory: [ref(LONG)], root: leaf() },
      { id: "kept", name: "Kept", shellKind: "default", broadcast: false, note: "既存メモ",
        agentHistory: [ref(FIRST)], root: leaf() },
      { id: "touched", name: "Touched", shellKind: "default", broadcast: false, noteTouched: true,
        agentHistory: [ref(FIRST)], root: leaf() },
      { id: "live", name: "Live", shellKind: "default", broadcast: false, root: leaf() },
    ],
  });
  window.__mockAgentPrompts = {
    [EMPTY]: [{ text: "/model opus", timestamp: null, images: 0, command: true }],
    [FIRST]: [
      { text: "  ログイン画面の\nバグを直して ", timestamp: null, images: 0, command: false },
      { text: "テストも追加して", timestamp: null, images: 0, command: false },
    ],
    [LATER]: [{ text: "後の会話", timestamp: null, images: 0, command: false }],
    [LONG]: [{ text: LONG_TEXT, timestamp: null, images: 0, command: false }],
    [LIVE]: [{ text: "実行中の会話の最初の入力", timestamp: null, images: 0, command: false }],
  };
}, { EMPTY, FIRST, LATER, LONG, LIVE, LONG_TEXT });
await page.goto(BASE_URL);
await page.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });

const noteOf = (id) => page.evaluate(async (id) => {
  const { workspaces } = await import("/src/workspace/state.ts");
  return workspaces.find((w) => w.id === id)?.note ?? "";
}, id);
// async 述語は waitForFunction だと即 truthy になるため自前で待つ
async function waitFor(fn, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// ---- 起動後の1巡 ----
check("an empty note is filled with the first prompt of the session's history",
  await waitFor(async () => (await noteOf("fill")) === "ログイン画面の バグを直して"), await noteOf("fill"));
check("the sidebar shows the filled note",
  (await page.locator('.ws-item[data-ws-id="fill"] .ws-note-display').textContent()) ===
    "ログイン画面の バグを直して");
const longNote = await noteOf("long");
check("long prompts are cut to the note limit with an ellipsis",
  longNote.length === 120 && longNote.endsWith("…"), String(longNote.length));
check("an existing note is kept", (await noteOf("kept")) === "既存メモ");
check("a session whose note was edited before stays empty", (await noteOf("touched")) === "");
check("conversations after the first prompt are not read",
  await page.evaluate((LATER) =>
    !(window.__agentPromptCalls ?? []).flat().some((r) => r.id === LATER), LATER));
check("prompts are read one conversation per call",
  await page.evaluate(() => (window.__agentPromptCalls ?? []).every((refs) => refs.length === 1)));

// ---- 実行中の会話 ----
const livePane = await page.evaluate(async () => {
  const { workspaces } = await import("/src/workspace/state.ts");
  return [...workspaces.find((w) => w.id === "live").panes.values()][0].id;
});
await page.evaluate(({ id, LIVE }) => {
  window.__mockPtyAgents = { [id]: "claude" };
  window.__mockAgentSessionId = LIVE;
}, { id: livePane, LIVE });
check("a running conversation's first prompt fills the empty note",
  await waitFor(async () => (await noteOf("live")) === "実行中の会話の最初の入力"), await noteOf("live"));

// ---- 保存と、消した後に埋め直さないこと ----
await page.evaluate(async () => {
  const { workspaces } = await import("/src/workspace/state.ts");
  const { updateWorkspaceNote } = await import("/src/workspace/workspace.ts");
  updateWorkspaceNote(workspaces.find((w) => w.id === "live"), "");
  const { flushSessionSave } = await import("/src/app/session.ts");
  await flushSessionSave();
});
await page.waitForTimeout(6000); // 次の検知スイープを1回以上またぐ
check("a note cleared by the user is not filled again", (await noteOf("live")) === "");
await page.evaluate(async () => {
  const { flushSessionSave } = await import("/src/app/session.ts");
  await flushSessionSave();
});
const saved = await page.evaluate(() => {
  const data = JSON.parse(window.__savedSession ?? "{}");
  return Object.fromEntries((data.workspaces ?? []).map((w) => [w.id, [w.note ?? "", w.noteTouched ?? null]]));
});
check("auto-filled and cleared notes are saved as touched",
  saved.fill?.[1] === true && saved.live?.[0] === "" && saved.live?.[1] === true &&
    saved.kept?.[1] === null, JSON.stringify(saved));

check("no page errors", errors.length === 0, errors.join(" / "));
await page.close();
}
