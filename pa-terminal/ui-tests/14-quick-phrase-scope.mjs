export default async function (ctx) {
const { browser, check, MOD, BASE_URL } = ctx;

// ============================================================
// 定型文の保存先（汎用 / このリポジトリ専用）と帯のたたみ状態の復元
// ============================================================

const pageQp = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageQp.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageQp.addInitScript(() => {
  window.__mockPtyCwd = "/repo";
  window.__mockGitChanges = {
    repo: true,
    root: "/repo",
    files: [{ path: "src/app.ts", adds: 1, dels: 0, status: "M" }],
  };
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "a",
    groups: [],
    settings: {
      language: "en",
      // 汎用 = repo 無し。専用 = repo にリポジトリルート
      quickPhrases: [
        "works anywhere",
        { text: "repo only", repo: "/repo" },
        { text: "other repo only", repo: "/other" },
      ],
      collapsed: { changes: true },
    },
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "alpha" } },
    ],
  });
});
await pageQp.goto(BASE_URL);
await pageQp.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageQp.locator(".pane .pane-body").first().click();
await pageQp.waitForSelector("#agent-panel:not([hidden])", { timeout: 8000 }).catch(() => {});
await pageQp.waitForTimeout(300);

// 変更があっても、保存された「1行表示」のまま起動する
const restoredChangeStrip = await pageQp.evaluate(() => ({
  compact: document.querySelector("#agent-panel")?.classList.contains("is-collapsed"),
  content: Boolean(document.querySelector("#agent-content")?.getClientRects().length),
  changes: Boolean(document.querySelector("#git-changes")?.getClientRects().length),
  actions: Boolean(document.querySelector("#git-actions")?.getClientRects().length),
}));
check("compact changes strip is restored on boot",
  restoredChangeStrip.compact === true && restoredChangeStrip.content
    && !restoredChangeStrip.changes && restoredChangeStrip.actions
    && (await pageQp.locator("#agent-panel").isVisible()),
  `state=${JSON.stringify(restoredChangeStrip)}`);

const qpChips = () => pageQp.locator(".quick-phrase-chip").allTextContents();
check("bar shows global phrases and the ones for this repository",
  JSON.stringify(await qpChips()) === JSON.stringify(["works anywhere", "repo only"]),
  `chips=${JSON.stringify(await qpChips())}`);
check("repo-scoped chips are marked apart from global ones",
  (await pageQp.locator(".quick-phrase-chip.is-repo").allTextContents()).join() === "repo only");

await pageQp.click("#quick-phrases-open");
check("the manager lists phrases of every repository",
  (await pageQp.locator(".quick-phrase-use").allTextContents()).length === 3);
check("phrases of another repository are tagged and dimmed",
  (await pageQp.locator(".quick-phrase-row.is-inactive .quick-phrase-use").allTextContents())
    .join() === "other repo only"
    && (await pageQp.locator(".quick-phrase-scope-tag").allTextContents()).join() === "repo,other");
const repoScopeLabel = await pageQp.locator("#quick-phrase-scope-repo-label").textContent();
check("the scope picker names the watched repository", (repoScopeLabel ?? "").includes("repo"),
  `label=${JSON.stringify(repoScopeLabel)}`);

// このリポジトリ専用として追加する
await pageQp.check("#quick-phrase-scope-repo");
await pageQp.fill("#quick-phrase-input", "build this repo");
await pageQp.click("#quick-phrase-submit");
await pageQp.keyboard.press("Escape");
check("a repo-scoped phrase shows on the bar of that repository",
  (await qpChips()).includes("build this repo"));
await pageQp.waitForFunction(
  () => {
    try {
      return JSON.parse(window.__savedSession).settings?.quickPhrases
        ?.some((p) => p?.text === "build this repo" && p?.repo === "/repo");
    } catch { return false; }
  },
  undefined,
  { timeout: 5000 },
).catch(() => {});
const savedScoped = await pageQp.evaluate(() =>
  JSON.parse(window.__savedSession).settings?.quickPhrases?.find((p) => p?.text === "build this repo"));
check("the repository of a phrase is persisted", savedScoped?.repo === "/repo",
  `saved=${JSON.stringify(savedScoped)}`);

// 別のリポジトリへ移ると、専用の定型文が入れ替わる（汎用は残る）
await pageQp.evaluate(async () => {
  window.__mockGitChanges = { repo: true, root: "/other", files: [] };
  const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
  updateGitWatch();
});
await pageQp.waitForFunction(
  () => [...document.querySelectorAll(".quick-phrase-chip")]
    .some((chip) => chip.textContent === "other repo only"),
  undefined,
  { timeout: 5000 },
).catch(() => {});
check("moving to another repository swaps the repo-scoped phrases",
  JSON.stringify(await qpChips()) === JSON.stringify(["works anywhere", "other repo only"]),
  `chips=${JSON.stringify(await qpChips())}`);
await pageQp.evaluate(async () => {
  window.__mockGitChanges = { repo: false, root: null, files: [] };
  const { updateGitWatch } = await import("/src/features/git/agent-panel.ts");
  updateGitWatch();
});
await pageQp.waitForFunction(
  () => [...document.querySelectorAll(".quick-phrase-chip")]
    .every((chip) => chip.textContent !== "other repo only"),
  undefined,
  { timeout: 5000 },
).catch(() => {});
check("outside a repository only the global phrases remain",
  JSON.stringify(await qpChips()) === JSON.stringify(["works anywhere"]),
  `chips=${JSON.stringify(await qpChips())}`);
await pageQp.click("#quick-phrases-open");
check("the scope picker disables repo-only outside a repository",
  await pageQp.locator("#quick-phrase-scope-repo").isDisabled()
    && await pageQp.locator("#quick-phrase-scope-global").isChecked());
await pageQp.keyboard.press("Escape");

// --- 定型文バーも変更ストリップと同じく1行表示にできる（開くまで全展開しない） ---
// 帯が複数行になるまで登録し、既定の1行表示と全展開の両方を測る
await pageQp.evaluate(async () => {
  const { setQuickPhrases } = await import("/src/features/quick-phrases/quick-phrases.ts");
  setQuickPhrases(Array.from({ length: 8 }, (_, i) => `a fairly long quick phrase number ${i + 1}`));
});
await pageQp.waitForTimeout(120);
const qpDefaultCompact = await pageQp.evaluate(() => {
  const chips = [...document.querySelectorAll(".quick-phrase-chip")];
  const list = document.querySelector("#quick-phrase-bar-list");
  const scrollbar = document.querySelector("#quick-phrase-scrollbar");
  const thumb = document.querySelector("#quick-phrase-scroll-thumb");
  return {
    compact: document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"),
    content: Boolean(document.querySelector("#quick-phrase-bar-content")?.getClientRects().length),
    rows: new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top))).size,
    clipped: Boolean(list && list.scrollWidth > list.clientWidth),
    customScroll: Boolean(scrollbar?.getClientRects().length),
    trackWidth: scrollbar?.getBoundingClientRect().width ?? 0,
    thumbWidth: thumb?.getBoundingClientRect().width ?? 0,
    hint: Boolean(document.querySelector("#quick-phrase-bar-hint")?.getClientRects().length),
  };
});
check("quick phrases default to a one-line preview",
  qpDefaultCompact.compact === true && qpDefaultCompact.content && qpDefaultCompact.rows === 1
    && qpDefaultCompact.clipped && qpDefaultCompact.hint && qpDefaultCompact.customScroll
    && qpDefaultCompact.thumbWidth > 0 && qpDefaultCompact.thumbWidth < qpDefaultCompact.trackWidth,
  `state=${JSON.stringify(qpDefaultCompact)}`);
check("the quick phrase shortcut hint stays visible beside the horizontal scroller",
  qpDefaultCompact.hint && qpDefaultCompact.clipped);
await pageQp.locator("#quick-phrase-collapse").click();
await pageQp.waitForTimeout(120);
const qpGridExpanded = await pageQp.evaluate(
  () => document.querySelector("#grid").getBoundingClientRect().height);
await pageQp.locator("#quick-phrase-collapse").click();
await pageQp.waitForTimeout(120);
const qpCollapsed = await pageQp.evaluate(() => ({
  ...(() => {
    const list = document.querySelector("#quick-phrase-bar-list");
    return {
      clipped: Boolean(list && list.scrollWidth > list.clientWidth),
      overflowX: list ? getComputedStyle(list).overflowX : "",
    };
  })(),
  compact: document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"),
  content: Boolean(document.querySelector("#quick-phrase-bar-content")?.getClientRects().length),
  chips: Boolean(document.querySelector("#quick-phrase-bar-list")?.getClientRects().length),
  bar: Boolean(document.querySelector("#quick-phrase-bar")?.getClientRects().length),
  summary: document.querySelector("#quick-phrase-bar-summary")?.textContent ?? "",
  customScroll: Boolean(document.querySelector("#quick-phrase-scrollbar")?.getClientRects().length),
  gridHeight: document.querySelector("#grid").getBoundingClientRect().height,
}));
check("collapsing the quick phrase bar keeps a one-line chip preview",
  qpCollapsed.compact === true && qpCollapsed.content && qpCollapsed.chips
    && qpCollapsed.bar && qpCollapsed.summary.includes("8")
    && qpCollapsed.clipped && qpCollapsed.overflowX === "auto" && qpCollapsed.customScroll,
  `state=${JSON.stringify(qpCollapsed)}`);
const qpScrollBeforeDrag = await pageQp.locator("#quick-phrase-bar-list").evaluate((el) => el.scrollLeft);
const qpScrollThumbBox = await pageQp.locator("#quick-phrase-scroll-thumb").boundingBox();
if (qpScrollThumbBox) {
  await pageQp.mouse.move(qpScrollThumbBox.x + qpScrollThumbBox.width / 2,
    qpScrollThumbBox.y + qpScrollThumbBox.height / 2);
  await pageQp.mouse.down();
  await pageQp.mouse.move(qpScrollThumbBox.x + qpScrollThumbBox.width / 2 + 50,
    qpScrollThumbBox.y + qpScrollThumbBox.height / 2);
  await pageQp.mouse.up();
}
const qpScrollAfterDrag = await pageQp.locator("#quick-phrase-bar-list").evaluate((el) => el.scrollLeft);
check("the custom quick phrase scrollbar thumb can be dragged",
  Boolean(qpScrollThumbBox) && qpScrollAfterDrag > qpScrollBeforeDrag,
  `scroll=${qpScrollBeforeDrag}->${qpScrollAfterDrag}`);
check("the one-line quick phrase bar gives the extra height back to the grid",
  qpCollapsed.gridHeight > qpGridExpanded,
  `grid=${qpCollapsed.gridHeight} was=${qpGridExpanded}`);
// 定型文を足しても勝手に全展開しない
await pageQp.click("#quick-phrases-open");
await pageQp.fill("#quick-phrase-input", "added while collapsed");
await pageQp.click("#quick-phrase-submit");
await pageQp.keyboard.press("Escape");
await pageQp.waitForTimeout(120);
check("adding a phrase does not expand the compact bar",
  (await pageQp.evaluate(() =>
    document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"))) === true);
await pageQp.waitForFunction(
  () => {
    try { return JSON.parse(window.__savedSession).settings?.collapsed?.quickPhrases === true; }
    catch { return false; }
  },
  undefined,
  { timeout: 5000 },
).catch(() => {});
const savedQpCollapsed = await pageQp.evaluate(
  () => JSON.parse(window.__savedSession).settings?.collapsed);
check("compact quick phrase bar state and one-line format are persisted",
  savedQpCollapsed?.quickPhrases === true && savedQpCollapsed?.oneLine === true,
  `collapsed=${JSON.stringify(savedQpCollapsed)}`);
await pageQp.locator("#quick-phrase-collapse").click();
await pageQp.waitForTimeout(120);
const qpExpanded = await pageQp.evaluate(() => ({
  compact: document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"),
  rows: new Set([...document.querySelectorAll(".quick-phrase-chip")]
    .map((chip) => Math.round(chip.getBoundingClientRect().top))).size,
}));
check("expanding the quick phrase bar shows every chip row",
  qpExpanded.compact === false && qpExpanded.rows > 1
    && (await pageQp.locator("#quick-phrase-bar-summary").isHidden()),
  `state=${JSON.stringify(qpExpanded)}`);
// 三角ボタン以外に「帯の空白」クリックでも開閉できる（見出し行・帯そのものが対象）
const qpBlankClick = (sel) => pageQp.evaluate((s) => {
  document.querySelector(s).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}, sel);
const qpBarCompact = () => pageQp.evaluate(() =>
  document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"));
await qpBlankClick("#quick-phrase-bar-head");
await pageQp.waitForTimeout(120);
check("clicking the blank head compacts the quick phrase bar", (await qpBarCompact()) === true);
await qpBlankClick("#quick-phrase-bar");
await pageQp.waitForTimeout(120);
check("clicking the blank compact bar expands it", (await qpBarCompact()) === false);
// ヒント文では開閉しない。チップを選んだ後は一時的に1行表示へ戻る。
await qpBlankClick("#quick-phrase-bar-hint");
await pageQp.waitForTimeout(80);
check("clicking the bar hint does not compact the bar", (await qpBarCompact()) === false);
await pageQp.locator(".quick-phrase-chip").first().click();
await pageQp.waitForTimeout(80);
check("clicking a chip compacts the quick phrase bar", (await qpBarCompact()) === true);
const qpAutoCollapsedScroll = await pageQp.evaluate(() => {
  const list = document.querySelector("#quick-phrase-bar-list");
  return {
    clipped: Boolean(list && list.scrollWidth > list.clientWidth),
    overflowX: list ? getComputedStyle(list).overflowX : "",
    customScroll: Boolean(document.querySelector("#quick-phrase-scrollbar")?.getClientRects().length),
  };
});
check("automatic compaction restores the quick phrase horizontal scroller",
  qpAutoCollapsedScroll.clipped && qpAutoCollapsedScroll.overflowX === "auto"
    && qpAutoCollapsedScroll.customScroll,
  `state=${JSON.stringify(qpAutoCollapsedScroll)}`);
const preferredQpState = await pageQp.evaluate(async () => {
  const { isQuickPhraseBarCollapsed } = await import("/src/features/quick-phrases/quick-phrases.ts");
  return isQuickPhraseBarCollapsed();
});
check("automatic compaction keeps the manually expanded default", preferredQpState === false,
  `preferredCollapsed=${preferredQpState}`);
await pageQp.close();

// 1行表示の定型文バーは次の起動でも同じまま（Cmd/Ctrl+P では開いて選べる）
const pageQpBoot = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageQpBoot.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageQpBoot.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "a",
    groups: [],
    settings: {
      language: "en",
      quickPhrases: ["works anywhere"],
      collapsed: { quickPhrases: true, oneLine: true },
    },
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "alpha" } },
    ],
  });
});
await pageQpBoot.goto(BASE_URL);
await pageQpBoot.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageQpBoot.waitForTimeout(300);
check("compact quick phrase bar is restored on boot",
  (await pageQpBoot.evaluate(() =>
    document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"))) === true
    && await pageQpBoot.locator("#quick-phrase-bar-content").isVisible()
    && await pageQpBoot.locator(".quick-phrase-chip").isVisible());
await pageQpBoot.locator(".pane .pane-body").first().click();
await pageQpBoot.keyboard.press(`${MOD}+KeyP`);
await pageQpBoot.waitForTimeout(120);
check("the quick phrase shortcut opens the bar and selects a chip",
  (await pageQpBoot.evaluate(() =>
    document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"))) === false
    && (await pageQpBoot.locator(".quick-phrase-chip.is-active").count()) === 1);
await pageQpBoot.keyboard.press("Enter");
await pageQpBoot.waitForTimeout(120);
const qpBootAfterInsert = await pageQpBoot.evaluate(async () => {
  const { isQuickPhraseBarCollapsed } = await import("/src/features/quick-phrases/quick-phrases.ts");
  return {
    compact: document.querySelector("#quick-phrase-bar")?.classList.contains("is-collapsed"),
    preferredCompact: isQuickPhraseBarCollapsed(),
  };
});
check("selecting a quick phrase closes the temporarily opened bar",
  qpBootAfterInsert.compact === true && qpBootAfterInsert.preferredCompact === true,
  `state=${JSON.stringify(qpBootAfterInsert)}`);
await pageQpBoot.close();

}
