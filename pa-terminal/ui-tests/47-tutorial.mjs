// 初回チュートリアル: 初回インストール / v1.0.0 より前からの更新で一度だけ出し、
// 新規セッション → フォルダー選択 → ペイン分割を実際の操作で進められる
export default async function ({ browser, check, BASE_URL }) {
  const saved = (page) => page.evaluate(() => {
    const raw = window.__savedSession;
    return raw ? JSON.parse(raw).settings?.tutorial : undefined;
  });
  const waitSaved = (page, value) =>
    page.waitForFunction((v) => {
      const raw = window.__savedSession;
      return raw && JSON.parse(raw).settings?.tutorial === v;
    }, value, { timeout: 5000 });
  const step = (page) => page.evaluate(() => document.querySelector("#tutorial")?.dataset.step ?? null);

  // ---- 初回インストール: ようこそ → 実操作で3ステップ → 完了
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(() => { window.__mockTutorial = true; });
  await page.goto(BASE_URL);
  await page.waitForSelector("#tutorial[data-step=welcome] .tut-card");
  check("fresh install: the welcome card opens without the update badge",
    (await page.locator(".tut-update-badge").count()) === 0 &&
    (await page.locator(".tut-tile").count()) === 3);
  check("fresh install: the license guide waits until the tour ends",
    await page.evaluate(() => document.querySelector("#guide-panel").hidden));

  await page.locator(".tut-btn.is-primary").click();
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "session");
  const spotOnPlus = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 450));
    const s = document.querySelector(".tut-spot").getBoundingClientRect();
    const b = document.querySelector("#ws-new").getBoundingClientRect();
    return s.left <= b.left && s.right >= b.right && s.top <= b.top && s.bottom >= b.bottom;
  });
  check("session step: the spotlight surrounds the + button", spotOnPlus);
  check("session step: no Next button, only skip", (await page.locator(".tut-card .tut-btn.is-primary").count()) === 0 &&
    (await page.locator(".tut-card .tut-skip").count()) === 1);

  // スポットライト中もクリックは塞がない: ＋ を押すと作成され、フォルダーのステップへ進む
  const wsBefore = await page.evaluate(async () => (await import("/src/workspace/state.ts")).workspaces.length);
  await page.locator("#ws-new").click();
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "folder");
  check("session step: clicking + creates a session and advances",
    await page.evaluate(async (n) => (await import("/src/workspace/state.ts")).workspaces.length === n + 1, wsBefore));
  await page.waitForSelector(".pathbar-pop");
  const spotOnBrowser = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 450));
    const s = document.querySelector(".tut-spot").getBoundingClientRect();
    const p = document.querySelector(".pathbar-pop").getBoundingClientRect();
    return Math.abs(s.left - (p.left - 6)) < 2 && Math.abs(s.top - (p.top - 6)) < 2;
  });
  check("folder step: the spotlight follows the opened folder browser", spotOnBrowser);

  // 矢印は段階ごとに次の操作を指す: 移動先のフォルダー行 → 「ここへ移動」
  const pointerAt = (selector) => page.evaluate(async (selector) => {
    await new Promise((r) => setTimeout(r, 500));
    const p = document.querySelector(".tut-pointer");
    const t = document.querySelector(selector);
    if (!p?.classList.contains("is-shown") || !t) return false;
    const a = p.getBoundingClientRect(), b = t.getBoundingClientRect();
    // 矢印の中心が対象の上下左右すぐ隣（60px 以内）にある
    const cx = a.left + a.width / 2, cy = a.top + a.height / 2;
    const dx = Math.max(b.left - cx, 0, cx - b.right), dy = Math.max(b.top - cy, 0, cy - b.bottom);
    return Math.hypot(dx, dy) < 60;
  }, selector);
  check("folder step: no Next button — the user has to do it", (await page.locator(".tut-card .tut-btn.is-primary").count()) === 0);
  check("folder step: the arrow points at a folder row first",
    await pointerAt(".pathbar-pop .pathbar-row.is-dir") &&
    await page.evaluate(() => document.querySelector(".tut-task.is-current")?.textContent.includes("移動先")));
  await page.locator(".pathbar-row", { hasText: "proj" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "proj");
  check("folder step: after opening a folder the arrow moves to “Move here”",
    await pointerAt(".pathbar-pop .pathbar-actions .is-primary") &&
    await page.evaluate(() => document.querySelectorAll(".tut-task.is-done").length === 2));
  const writesBefore = await page.evaluate(() => window.__ptyWrites.length);
  await page.locator(".pathbar-actions .is-primary").click();
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "split");
  check("folder step: “Move here” moves the terminal and advances",
    await page.evaluate((n) => window.__ptyWrites.slice(n).some((w) => w.data.includes("/home/user/proj")), writesBefore));
  check("split step: the arrow points at the split button", await pointerAt("#split-right"));
  await page.locator("#split-right").click();
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "done");
  check("split step: splitting a pane advances to the finish card", true);
  check("before finishing, the tour stays pending in session.json", (await saved(page)) !== "done");
  await page.locator(".tut-btn.is-primary").click();
  await page.waitForFunction(() => !document.querySelector("#tutorial"));
  await waitSaved(page, "done");
  check("finishing saves the tour as done", true);

  // 設定 → ヘルプから再表示できる
  await page.locator("#settings-open").click();
  await page.locator('.settings-nav-item[data-section="help"]').click();
  await page.locator("#settings-tutorial-replay").click();
  await page.waitForSelector("#tutorial[data-step=welcome]");
  check("settings: replaying closes settings and reopens the tour",
    await page.evaluate(() => document.querySelector("#settings-overlay").hidden));
  const focusInCard = await page.waitForFunction(
    () => document.querySelector(".tut-card")?.contains(document.activeElement), null, { timeout: 3000 },
  ).then(() => true, () => false);
  check("the welcome card takes keyboard focus", focusInCard,
    await page.evaluate(() => document.activeElement?.className ?? ""));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#tutorial"), null, { timeout: 3000 });
  check("Escape on the card dismisses the tour", true);
  await page.close();

  // ---- v1.0.0 より前の保存データ（tutorial なし）: 「アップデートされました」で出す
  const legacy = JSON.stringify({
    version: 5,
    activeId: "a",
    groups: [],
    collapsedGroups: [],
    settings: { theme: "dark", language: "ja" },
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "alpha" } },
    ],
  });
  const up = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await up.addInitScript((data) => {
    window.__mockTutorial = true;
    window.__mockSessionLoad = data;
  }, legacy);
  await up.goto(BASE_URL);
  await up.waitForSelector("#tutorial[data-step=welcome] .tut-update-badge");
  const upCopy = await up.evaluate(() => ({
    badge: document.querySelector(".tut-update-badge").textContent,
    title: document.querySelector(".tut-title").textContent,
  }));
  check("pre-1.0 user: the tour opens with the updated badge and version",
    upCopy.badge.includes("アップデートされました") && upCopy.badge.includes("v0.2.0") &&
    upCopy.title.includes("アップデート"), JSON.stringify(upCopy));
  await up.locator(".tut-btn.is-ghost").click(); // あとで
  await up.waitForFunction(() => !document.querySelector("#tutorial"));
  await waitSaved(up, "done");
  check("pre-1.0 user: skipping saves done", true);
  await up.close();

  // ---- 表示済み（done）なら出さない
  const seen = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await seen.addInitScript((data) => {
    window.__mockTutorial = true;
    const s = JSON.parse(data);
    s.settings.tutorial = "done";
    window.__mockSessionLoad = JSON.stringify(s);
  }, legacy);
  await seen.goto(BASE_URL);
  await seen.waitForSelector(".pane .xterm-helper-textarea");
  await seen.waitForTimeout(400);
  check("after the tour was seen, it does not open again", (await step(seen)) === null);
  await seen.close();
}
