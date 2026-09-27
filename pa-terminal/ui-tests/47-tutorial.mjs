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
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "basics:session");
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
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "basics:folder");
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
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "basics:split");
  check("folder step: “Move here” moves the terminal and advances",
    await page.evaluate((n) => window.__ptyWrites.slice(n).some((w) => w.data.includes("/home/user/proj")), writesBefore));
  check("split step: the arrow points at the split button", await pointerAt("#split-right"));
  await page.locator("#split-right").click();
  await page.waitForFunction(() => document.querySelector("#tutorial")?.dataset.step === "done");
  check("split step: splitting a pane advances to the finish card", true);
  check("before finishing, the tour stays pending in session.json", (await saved(page)) !== "done");
  check("the finish card offers the other tours",
    (await page.locator(".tut-card .tut-btn", { hasText: "ほかのツアーを見る" }).count()) === 1);
  await page.locator(".tut-btn.is-primary").click();
  // 初回の後は一度だけ「ツアー」ボタンを矢印で紹介する
  await page.waitForSelector("#tutorial[data-step=hint]");
  check("after the first tour, the Tour button is introduced once with the arrow", await pointerAt("#tutorial-open"));
  await waitSaved(page, "done");
  await page.locator(".tut-card .tut-btn.is-primary").click();
  await page.waitForFunction(() => !document.querySelector("#tutorial"));
  check("finishing saves the tour as done and remembers the basics tour",
    await page.evaluate(() => JSON.parse(window.__savedSession).settings.tours?.includes("basics")));

  // 上部バーの「ツアー」（Worktree の右隣）から一覧を開き、各編を選べる
  check("toolbar: the tour button sits right after Worktree", await page.evaluate(() =>
    document.querySelector("#worktree-open").nextElementSibling?.id === "tutorial-open" &&
    document.querySelector("#tutorial-open .toolbar-label").textContent === "ツアー"));
  check("settings no longer has a Help section",
    (await page.locator('.settings-nav-item[data-section="help"]').count()) === 0);
  await page.locator("#tutorial-open").click();
  await page.waitForSelector("#tutorial[data-step=picker]");
  const picker = await page.evaluate(() => [...document.querySelectorAll(".tut-tour")].map((b) =>
    `${b.dataset.tour}:${b.querySelector(".tut-tour-meta").classList.contains("is-done") ? "done" : "-"}`));
  check("picker: lists the five tours and marks the basics as completed",
    picker.join(",") === "basics:done,view:-,phrases:-,history:-,git:-", picker.join(","));
  const focusInCard = await page.waitForFunction(
    () => document.querySelector(".tut-card")?.contains(document.activeElement), null, { timeout: 3000 },
  ).then(() => true, () => false);
  check("the picker card takes keyboard focus", focusInCard,
    await page.evaluate(() => document.activeElement?.className ?? ""));

  const at = (id) => page.waitForFunction((id) => document.querySelector("#tutorial")?.dataset.step === id, id, { timeout: 5000 })
    .then(() => true, () => false);
  const next = () => page.locator(".tut-card .tut-btn.is-primary").click();
  const toPicker = async () => {
    await at("done");
    await page.locator(".tut-card .tut-btn", { hasText: "ほかのツアーを見る" }).click();
    await page.waitForSelector("#tutorial[data-step=picker]");
  };

  // ---- セッション分割編（セッションは基本ツアーで2つあるので準備は飛ばす）
  await page.locator('.tut-tour[data-tour="view"]').click();
  check("view tour: skips preparing sessions when two exist and points at the split view button",
    await at("view:open") && await pointerAt("#session-view-open"));
  await page.locator("#session-view-open").click();
  check("view tour: opening the dialog advances to picking sessions", await at("view:pick"));
  for (let i = 0; i < 4 && await page.evaluate(() => document.querySelector("#tutorial")?.dataset.step === "view:pick"); i++) {
    await page.locator("#session-view-list label.bc-row:not(:has(input:checked))").first().click();
    await page.waitForTimeout(250);
  }
  check("view tour: checking two sessions advances to the layout explanation", await at("view:modes"));
  await next();
  check("view tour: then points at “Show together”", await at("view:apply") && await pointerAt("#session-view-apply"));
  await page.locator("#session-view-apply").click();
  check("view tour: applying shows the sessions together and explains the headers",
    await at("view:header") && await page.evaluate(() => !!document.querySelector("#grid.multi-session")));
  await next();
  await toPicker();
  check("view tour: completing marks it in the picker",
    await page.locator('.tut-tour[data-tour="view"] .tut-tour-meta.is-done').count() === 1);

  // ---- 定型文編: 開く → 登録 → 範囲 → クリックで入力 → バー
  await page.locator('.tut-tour[data-tour="phrases"]').click();
  await at("phrases:open");
  await page.locator("#quick-phrases-open").click();
  check("phrases tour: opening advances to adding a phrase with the input pointed at",
    await at("phrases:add") && await pointerAt("#quick-phrase-input"));
  await page.locator("#quick-phrase-input").fill("テストも実行して");
  check("phrases tour: after typing, the arrow moves to the add button", await pointerAt("#quick-phrase-submit"));
  await page.locator("#quick-phrase-submit").click();
  check("phrases tour: adding advances to the scope explanation", await at("phrases:scope"));
  await next();
  await at("phrases:use");
  const writesBeforePhrase = await page.evaluate(() => window.__ptyWrites.length);
  await page.locator("#quick-phrases-list .quick-phrase-use").last().click();
  check("phrases tour: clicking the phrase types it into the terminal and advances",
    await at("phrases:bar") &&
    await page.evaluate((n) => window.__ptyWrites.slice(n).some((w) => w.data.includes("テストも実行して")), writesBeforePhrase));
  await next();
  await toPicker();

  // ---- 入力履歴・履歴編
  await page.locator('.tut-tour[data-tour="history"]').click();
  await at("history:open");
  await page.locator("#prompt-history-open").click();
  check("history tour: opening prompt history advances", await at("history:sessions"));
  await next();
  await at("history:timeline");
  await next();
  check("history tour: asks to close prompt history", await at("history:close") && await pointerAt("#prompt-history-close"));
  await page.locator("#prompt-history-close").click();
  check("history tour: then points at History", await at("history:takeover") && await pointerAt("#takeover-open"));
  await page.locator("#takeover-open").click();
  await at("history:conversations");
  await next();
  check("history tour: points at the deleted sessions tab", await at("history:trashTab") && await pointerAt("#history-tab-trash"));
  await page.locator("#history-tab-trash").click();
  check("history tour: opening the tab advances to restoring", await at("history:trash"));
  await next();
  await toPicker();

  // ---- Git・Worktree編（リポジトリ外: 案内だけして閉じ、Worktree は説明のみ）
  await page.locator('.tut-tour[data-tour="git"]').click();
  await at("git:open");
  await page.locator("#git-open").click();
  check("git tour: outside a repository it explains how to use it", await at("git:norepo"));
  await next();
  check("git tour: then asks to close the Git window", await at("git:close") && await pointerAt("#gw-close"));
  await page.locator("#gw-close").click();
  check("git tour: Worktree is explained without opening while disabled", await at("git:wtInfo"));
  await next();
  check("git tour: ends at the finish card", await at("done"), await page.evaluate(() => document.querySelector("#tutorial")?.dataset.step ?? "closed"));
  check("git tour: finishes with a close button",
    (await page.locator(".tut-card .tut-btn.is-primary").textContent()) === "閉じる");
  check("all tours are remembered", await page.evaluate(async () => {
    const { flushSessionSave } = await import("/src/app/session.ts");
    await flushSessionSave();
    return JSON.parse(window.__savedSession).settings.tours.join(",") === "basics,view,phrases,history,git";
  }));
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
  // あとでにしても、ほかの紹介の場所は一度だけ知らせる。「ツアー」を押せば一覧が開く
  await up.waitForSelector("#tutorial[data-step=hint]");
  await waitSaved(up, "done");
  check("pre-1.0 user: skipping saves done and still introduces the Tour button", true);
  await up.locator("#tutorial-open").click();
  check("hint: pressing Tour opens the picker",
    await up.waitForSelector("#tutorial[data-step=picker]", { timeout: 3000 }).then(() => true, () => false));
  await up.locator(".tut-card .tut-btn.is-primary").click();
  await up.waitForFunction(() => !document.querySelector("#tutorial"));
  await up.locator("#tutorial-open").click();
  await up.waitForSelector("#tutorial[data-step=picker]");
  await up.waitForFunction(() => document.querySelector(".tut-card")?.contains(document.activeElement));
  await up.keyboard.press("Escape");
  await up.waitForTimeout(300);
  check("hint: the Tour button introduction is not repeated", (await up.locator("#tutorial").count()) === 0);
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

  // ---- ロック中はロック対象の機能の編を選べない
  const locked = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await locked.addInitScript(() => {
    window.__mockLicense = { official: true, state: "expired", locked: true, daysLeft: 0, supporter: false,
      keyMasked: null, keyKind: null, retrialAvailable: false, banner: null, guidePending: false,
      checkoutUrl: "https://polar.sh/checkout/PLACEHOLDER" };
  });
  await locked.goto(BASE_URL);
  await locked.waitForSelector(".pane .xterm-helper-textarea");
  await locked.locator("#tutorial-open").click();
  await locked.waitForSelector("#tutorial[data-step=picker]");
  const disabledTours = await locked.evaluate(() =>
    [...document.querySelectorAll(".tut-tour:disabled")].map((b) => b.dataset.tour).join(","));
  check("locked: phrases, history and git tours are disabled", disabledTours === "phrases,history,git", disabledTours);
  await locked.close();
}
