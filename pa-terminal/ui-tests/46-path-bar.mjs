// 全ペインの下部に出すパスバーと、アプリ内フォルダーブラウザー
export default async function ({ browser, check, BASE_URL }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane .xterm-helper-textarea");
  await page.waitForFunction(() => window.__ptySpawns.length > 0);
  const setAgent = (kind) => page.evaluate((kind) => {
    window.__mockPtyAgents = { [window.__ptySpawns[0].id]: kind };
  }, kind);
  const sweep = () => page.evaluate(async () => {
    const { panes } = await import("/src/workspace/state.ts");
    const { agentForDirectoryChange } = await import("/src/features/agents/watch.ts");
    await agentForDirectoryChange([...panes.values()][0]);
  });

  await page.waitForSelector(".pane-pathbar");
  const bar = await page.evaluate(() => {
    const el = document.querySelector(".pane-pathbar");
    const xterm = el.parentElement.querySelector(".xterm").getBoundingClientRect();
    return {
      badgeHidden: el.querySelector(".pane-pathbar-agent").hidden,
      leaf: el.querySelector(".pane-pathbar-leaf").textContent,
      cwd: el.dataset.cwd,
      last: el.parentElement.lastElementChild === el,
      fits: xterm.bottom <= el.getBoundingClientRect().top + 0.5,
    };
  });
  check("path bar: a plain shell pane shows its folder at the bottom without an agent label",
    bar.badgeHidden && bar.cwd === "/home/user" && bar.leaf === "~" && bar.last, JSON.stringify(bar));
  check("path bar: the terminal is fitted above the bar", bar.fits, JSON.stringify(bar));

  // シェルの cd（OSC 7）にすぐ追従する
  await page.evaluate(() => window.__ptyPushAll("\x1b]7;file://host/home/user/proj\x07"));
  await page.waitForFunction(() => document.querySelector(".pane-pathbar-leaf")?.textContent === "proj");
  check("path bar: follows the shell's cd immediately", true);

  // シェルでは「ここへ移動」がそのまま cd になる
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-row");
  await page.locator(".pathbar-row", { hasText: "src" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "src");
  await page.locator(".pathbar-action.is-primary").click();
  await page.waitForFunction(() => window.__ptyWrites.some((w) => w.data === "cd '/home/user/proj/src'\r"));
  check("shell: Move here cds the terminal without a dialog",
    (await page.locator("#move-directory-panel").count()) === 0 && (await page.locator(".pathbar-pop").count()) === 0);
  await page.evaluate(() => window.__ptyPushAll("\x1b]7;file://host/home/user\x07"));
  await page.waitForFunction(() => document.querySelector(".pane-pathbar-leaf")?.textContent === "~");

  // ポップオーバーの「ルート」: 一覧の表示先を既定のルート（ホーム）へ切り替えるだけで、
  // ターミナルは動かさない（移動は「ここへ移動」だけ）。コピーの左隣
  await page.evaluate(() => window.__ptyPushAll("\x1b]7;file://host/tmp\x07"));
  await page.waitForFunction(() => document.querySelector(".pane-pathbar-leaf")?.textContent === "tmp");
  const writesBeforeRoot = await page.evaluate(() => window.__ptyWrites.length);
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-pop");
  const rootBtn = page.locator(".pathbar-action", { hasText: "ルート" });
  check("root: sits left of copy and is enabled away from the default root",
    !(await rootBtn.isDisabled()) &&
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll(".pathbar-action span")].map((el) => el.textContent);
      return labels.indexOf("ルート") === labels.indexOf("コピー") - 1;
    }));
  await rootBtn.click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "~");
  check("root: only switches the listing to the default root without moving the terminal",
    (await page.locator(".pathbar-pop").count()) === 1 && await rootBtn.isDisabled() &&
    await page.evaluate((n) => window.__ptyWrites.length === n, writesBeforeRoot));
  await page.locator(".pathbar-action.is-primary").click();
  await page.waitForFunction(() => window.__ptyWrites.some((w) => w.data === "cd '/home/user'\r"));
  check("root: Move here then moves the terminal to the root", true);
  await page.evaluate(() => window.__ptyPushAll("\x1b]7;file://host/home/user\x07"));

  // OSC 7 を吐かないシェル: pty_cwd のポーリングでバーとサイドバーが追従する
  await page.evaluate(() => { window.__mockPtyCwd = "/home/user/proj/src"; });
  await page.waitForFunction(() =>
    document.querySelector(".pane-pathbar-leaf")?.textContent === "src" &&
    document.querySelector(".ws-sub")?.title === "/home/user/proj/src", null, { timeout: 12000 });
  check("poll: a cd without OSC 7 updates the path bar and the sidebar", true);
  await page.evaluate(() => { window.__mockPtyCwd = "/home/user"; });
  await page.waitForFunction(() => document.querySelector(".ws-sub")?.title === "/home/user", null, { timeout: 12000 });
  await page.evaluate(() => { window.__mockPtyCwd = null; });
  const cdWrites = await page.evaluate(() => window.__ptyWrites.filter((w) => /^cd /.test(w.data)).length);

  await setAgent("claude");
  await sweep();
  await page.waitForFunction(() => document.querySelector(".pane-pathbar-agent")?.textContent === "claude");
  check("path bar: labels a detected agent", !(await page.locator(".pane-pathbar-agent").isHidden()));

  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-row");
  const listed = await page.$$eval(".pathbar-row .pathbar-row-name", (els) => els.map((el) => el.textContent));
  check("browser: lists folders first and hides dotfiles",
    JSON.stringify(listed) === JSON.stringify(["big", "proj", "readme.md"]), JSON.stringify(listed));
  check("browser: the filter has focus", await page.evaluate(() =>
    document.activeElement === document.querySelector(".pathbar-filter input")));
  check("browser: cannot move to the folder the terminal is already in",
    await page.locator(".pathbar-action.is-primary").isDisabled());

  await page.keyboard.type(".");
  const hidden = await page.$$eval(".pathbar-row .pathbar-row-name", (els) => els.map((el) => el.textContent));
  check("browser: typing . reveals dotfiles", hidden.includes(".config") && hidden.includes(".hidden-file"), JSON.stringify(hidden));
  await page.locator(".pathbar-filter input").fill("pro");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "proj");
  const inProj = await page.$$eval(".pathbar-row .pathbar-row-name", (els) => els.map((el) => el.textContent));
  check("browser: Enter opens the filtered folder", JSON.stringify(inProj) === JSON.stringify(["src", "main.ts"]), JSON.stringify(inProj));
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "~");
  check("browser: Backspace on an empty filter goes up", true);
  check("browser: offers root, copy, favorites, Finder, new session and move actions",
    JSON.stringify(await page.$$eval(".pathbar-action span", (els) => els.map((el) => el.textContent))) ===
      JSON.stringify(["ルート", "コピー", "お気に入り", "Finderから選択", "新規セッション", "ここへ移動"]));
  await page.keyboard.press("Escape");

  // 大きさ: 既定は約2倍（760×640、画面に収める）で、広いので左に「場所」列が出る
  await page.evaluate(() => localStorage.removeItem("pa.folderBrowserSize"));
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-row");
  // 開くアニメーション（scale）を終わらせてから実寸を測る
  const popBox = () => page.evaluate(() => {
    const pop = document.querySelector(".pathbar-pop");
    for (const a of pop.getAnimations()) a.finish();
    const r = pop.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  });
  const big = await popBox();
  const barTop = await page.evaluate(() => document.querySelector(".pane-pathbar-path").getBoundingClientRect().top);
  check("size: opens about twice the old 380px popover and stays above the bar",
    big.w === 760 && big.h >= 400 && big.bottom <= barTop, JSON.stringify({ big, barTop }));
  const sideItems = await page.$$eval(".pathbar-side-item .pathbar-side-name", (els) => els.map((el) => el.textContent));
  check("side: the wide browser lists the terminal's folder in a places column",
    await page.locator(".pathbar-side").isVisible() && sideItems[0] === "ターミナルのフォルダー", JSON.stringify(sideItems));
  await page.locator(".pathbar-side-item", { hasText: "ターミナルのフォルダー" }).click();
  check("side: choosing a place keeps the browser open without moving the terminal",
    (await page.locator(".pathbar-pop").count()) === 1);

  // 右上の角をドラッグすると縮み、大きさは次回も残る。狭いと場所列は隠れる
  const grip = await page.locator(".pathbar-grip.is-xy").boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 260, grip.y + grip.height / 2 + 100, { steps: 4 });
  await page.mouse.up();
  const small = await popBox();
  check("resize: dragging the corner shrinks the browser and keeps it anchored to the bar",
    small.w === 500 && small.h === big.h - 100 && small.bottom === big.bottom, JSON.stringify({ big, small }));
  check("resize: a narrow browser hides the places column", await page.locator(".pathbar-side").isHidden());
  await page.keyboard.press("Escape");
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-pop");
  const reopened = await popBox();
  check("resize: the size is remembered for the next open", JSON.stringify(reopened) === JSON.stringify(small), JSON.stringify({ small, reopened }));
  await page.locator(".pathbar-grip.is-xy").dblclick();
  check("resize: double-clicking the corner restores the default size", (await popBox()).w === 760);
  await page.keyboard.press("Escape");


  // お気に入り: コピーの隣のボタンからメニューを開き、追加・ジャンプ・削除する。
  // 一覧はエクスプローラーのお気に入りと共有
  const favBtn = page.locator(".pathbar-fav-btn");
  const favorites = () => page.evaluate(async () =>
    (await import("/src/features/explorer/explorer.ts")).getExplorerFavorites().slice());
  const before = await favorites();
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-row");
  await page.locator(".pathbar-row", { hasText: "proj" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "proj");
  await favBtn.click();
  await page.waitForSelector(".pathbar-favs");
  check("favorites: the menu opens next to copy and offers adding the viewed folder",
    (await page.locator(".pathbar-fav-toggle").textContent()).includes("このフォルダーを追加") &&
    (await page.locator(".pathbar-fav-here").textContent()) === "proj");
  await page.locator(".pathbar-fav-toggle").click();
  const added = await favorites();
  check("favorites: adding stores the folder in the shared favorites and fills the star",
    added.includes("/home/user/proj") && added.length === before.length + 1 &&
    (await favBtn.getAttribute("class")).includes("is-on") &&
    (await page.locator(".pathbar-fav-row", { hasText: "proj" }).count()) === 1, JSON.stringify(added));
  await page.keyboard.press("Escape");
  check("favorites: Escape closes only the menu",
    (await page.locator(".pathbar-favs").count()) === 0 && (await page.locator(".pathbar-pop").count()) === 1);
  await page.locator(".pathbar-action", { hasText: "ルート" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "~");
  check("favorites: the star follows the viewed folder", !(await favBtn.getAttribute("class")).includes("is-on"));
  await favBtn.click();
  await page.locator(".pathbar-fav-row", { hasText: "proj" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "proj");
  check("favorites: choosing one switches the listing there without moving the terminal",
    (await page.locator(".pathbar-favs").count()) === 0 &&
    await page.evaluate(() => !window.__ptyWrites.some((w) => w.data.includes("proj'\r") && w.data.startsWith("cd '/home/user/proj'"))));
  await favBtn.click();
  await page.locator(".pathbar-fav-row", { hasText: "proj" }).hover();
  await page.locator(".pathbar-fav-row", { hasText: "proj" }).locator(".pathbar-fav-remove").click();
  check("favorites: × removes it from the shared favorites",
    JSON.stringify(await favorites()) === JSON.stringify(before) &&
    (await page.locator(".pathbar-fav-row", { hasText: "proj" }).count()) === 0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // ここへ移動: CLI 実行中は会話を引き継ぐ切り替えダイアログを、選んだパスで開く
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-row");
  await page.locator(".pathbar-row", { hasText: "proj" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "proj");
  await page.locator(".pathbar-action.is-primary").click();
  await page.waitForSelector("#move-directory-path");
  check("browser: Move here hands the folder to the directory switch dialog",
    (await page.locator("#move-directory-path").inputValue()) === "/home/user/proj");
  await page.keyboard.press("Escape");
  check("agent: nothing was spawned or cd'd into the running CLI",
    await page.evaluate((before) => window.__ptySpawns.length === 1 &&
      window.__ptyWrites.filter((w) => /^cd /.test(w.data)).length === before, cdWrites));

  // Esc で閉じるとペインへ戻る
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-pop");
  await page.keyboard.press("Escape");
  check("browser: Escape closes and returns focus to the terminal", await page.evaluate(async () => {
    const { panes } = await import("/src/workspace/state.ts");
    return !document.querySelector(".pathbar-pop") &&
      document.activeElement === [...panes.values()][0].term.textarea;
  }));

  await setAgent(null);
  await sweep();
  await page.waitForFunction(() => document.querySelector(".pane-pathbar-agent")?.hidden);
  check("path bar: stays after the CLI exits, dropping only the agent label",
    (await page.locator(".pane-pathbar").count()) === 1);

  // Finderから選択: OS で選んだフォルダーへ一覧を移すだけで、ターミナルは動かさない
  await page.evaluate(() => { window.__mockPickedDirectory = "/home/user/proj/src"; });
  const writesBeforeOs = await page.evaluate(() => window.__ptyWrites.length);
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-row");
  await page.locator(".pathbar-action", { hasText: "Finderから選択" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "src");
  check("Finder: choosing a folder moves only the listing and keeps the browser open",
    (await page.locator(".pathbar-pop").count()) === 1 &&
    await page.evaluate((n) => window.__ptyWrites.length === n, writesBeforeOs));
  await page.keyboard.press("Escape");

  // 新規セッション: 右下のボタンで表示中のフォルダーに作る（フォルダー行には操作を置かない）
  const spawnsBefore = await page.evaluate(() => window.__ptySpawns.length);
  await page.locator(".pane-pathbar-path").click();
  await page.waitForSelector(".pathbar-row");
  check("new session: folder rows carry no buttons", (await page.locator(".pathbar-row button").count()) === 0);
  await page.locator(".pathbar-row", { hasText: "proj" }).click();
  await page.waitForFunction(() => document.querySelector(".pathbar-crumb[aria-current]")?.textContent === "proj");
  await page.locator(".pathbar-action", { hasText: "新規セッション" }).click();
  await page.waitForFunction((n) => window.__ptySpawns.length > n, spawnsBefore);
  check("new session: the bottom button starts a session in the viewed folder",
    (await page.evaluate(() => window.__ptySpawns.at(-1).cwd)) === "/home/user/proj" &&
    (await page.locator(".pathbar-pop").count()) === 0);
  await page.close();
}
