export default async function (ctx) {
const { page, check, MOD } = ctx;

// ============================================================
// 定型文
// ============================================================

// --- 50. 定型文の追加・編集・挿入・削除・永続化 ---
check("quick phrase bar hidden with no phrases", await page.locator("#quick-phrase-bar").isHidden());
await page.click("#quick-phrases-open");
check("quick phrases overlay opens", await page.locator("#quick-phrases-overlay").isVisible());
check("quick phrases starts empty", await page.locator("#quick-phrases-empty").isVisible());

await page.fill("#quick-phrase-input", "続けてください");
await page.click("#quick-phrase-submit");
check("quick phrase can be added",
  (await page.locator(".quick-phrase-use").allTextContents()).includes("続けてください"));
check("added phrase shows on the bar",
  (await page.locator(".quick-phrase-chip").allTextContents()).includes("続けてください"));

const phraseWriteStart = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".quick-phrase-use", { hasText: "続けてください" }).click();
await page.waitForTimeout(100);
const phraseWrites = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""),
  phraseWriteStart,
);
check("quick phrase inserts without Enter",
  phraseWrites.includes("続けてください") && !phraseWrites.includes("\r"),
  `writes=${JSON.stringify(phraseWrites)}`);
check("inserting quick phrase closes overlay", await page.locator("#quick-phrases-overlay").isHidden());

// 定型文バーは変更ストリップ（ファイル変更）の1つ上の帯として出る
check("quick phrase bar visible once a phrase exists",
  await page.locator("#quick-phrase-bar").isVisible());
const barIsAboveChanges = await page.evaluate(() =>
  document.querySelector("#quick-phrase-bar")?.nextElementSibling?.id === "agent-panel");
check("quick phrase bar sits directly above the file changes strip", barIsAboveChanges);

// バーのチップは オーバーレイを開かずにそのまま入力できる（Enter は送らない）
const barWriteStart = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".quick-phrase-chip", { hasText: "続けてください" }).click();
await page.waitForTimeout(100);
const barWrites = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""),
  barWriteStart,
);
check("quick phrase bar chip inserts without Enter",
  barWrites.includes("続けてください") && !barWrites.includes("\r"),
  `writes=${JSON.stringify(barWrites)}`);

// --- 50b. 定型文のキーボード操作（Cmd/Ctrl+P → Tab/矢印で選択 → Enter で入力） ---
const activeChip = () => page.evaluate(() =>
  document.querySelector(".quick-phrase-chip.is-active")?.textContent ?? null);
const hintText = () => page.locator("#quick-phrase-bar-hint").textContent();

await page.click("#quick-phrases-open");
await page.fill("#quick-phrase-input", "テストを実行して");
await page.click("#quick-phrase-submit");
await page.keyboard.press("Escape");
const idleHint = await hintText();
check("quick phrase bar shows the shortcut hint", (idleHint ?? "").length > 0,
  `hint=${JSON.stringify(idleHint)}`);
check("no chip is selected before the shortcut", (await activeChip()) === null);

await page.keyboard.press(`${MOD}+KeyP`);
check("shortcut selects the first quick phrase",
  (await activeChip()) === "続けてください", `active=${await activeChip()}`);
check("selected chip takes focus",
  await page.evaluate(() => document.activeElement?.classList.contains("quick-phrase-chip")));
const selectHint = await hintText();
check("selection mode swaps in the key hint", (selectHint ?? "") !== idleHint && (selectHint ?? "").length > 0,
  `hint=${JSON.stringify(selectHint)}`);

await page.keyboard.press("Tab");
check("Tab moves to the next quick phrase", (await activeChip()) === "テストを実行して");
await page.keyboard.press("ArrowLeft");
check("arrow keys move the quick phrase selection", (await activeChip()) === "続けてください");
await page.keyboard.press("ArrowUp");
check("arrows wrap around the quick phrase list", (await activeChip()) === "テストを実行して");
await page.keyboard.press("Shift+Tab");
check("Shift+Tab moves back", (await activeChip()) === "続けてください");

const runStart = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
const runWrites = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""),
  runStart,
);
check("Enter inserts the selected phrase without running it",
  runWrites.includes("続けてください") && !runWrites.includes("\r"),
  `writes=${JSON.stringify(runWrites)}`);
check("inserting a phrase leaves selection mode", (await activeChip()) === null);
check("inserting a selected phrase compacts the quick phrase bar",
  await page.locator("#quick-phrase-bar").evaluate((el) => el.classList.contains("is-collapsed")));
check("inserting a phrase returns focus to the terminal",
  await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")));
check("hint returns to the shortcut after inserting", (await hintText()) === idleHint);
const confirmStart = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
const confirmWrites = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""),
  confirmStart,
);
check("a second Enter runs the inserted phrase", confirmWrites.includes("\r"),
  `writes=${JSON.stringify(confirmWrites)}`);

await page.keyboard.press(`${MOD}+KeyP`);
check("shortcut can be used again", (await activeChip()) !== null);
await page.keyboard.press("Escape");
check("Escape leaves quick phrase selection", (await activeChip()) === null);

// 管理モーダルでの並び替えは保存順とバーの順の両方に反映される
await page.click("#quick-phrases-open");
const rowsBeforeReorder = page.locator(".quick-phrase-row");
await rowsBeforeReorder.first().dragTo(rowsBeforeReorder.last(), { targetPosition: { x: 12, y: 28 } });
await page.waitForTimeout(100);
check("quick phrases can be reordered by dragging",
  JSON.stringify(await page.locator(".quick-phrase-use").allTextContents())
    === JSON.stringify(["テストを実行して", "続けてください"]));
check("reordering updates the quick phrase bar",
  JSON.stringify(await page.locator(".quick-phrase-chip").allTextContents())
    === JSON.stringify(["テストを実行して", "続けてください"]));
await page.waitForFunction(
  () => JSON.parse(window.__savedSession).settings?.quickPhrases?.[0]?.text === "テストを実行して",
  undefined,
  { timeout: 5000 },
).catch(() => {});
check("reordered quick phrases are persisted",
  await page.evaluate(() => JSON.parse(window.__savedSession).settings?.quickPhrases?.[0]?.text)
    === "テストを実行して");
// ハンドルの矢印キーでも並び替え、後続テスト用に元の順へ戻す
await page.locator(".quick-phrase-row").last().locator(".quick-phrase-reorder").focus();
await page.keyboard.press("ArrowUp");
check("quick phrases can be reordered with the keyboard",
  JSON.stringify(await page.locator(".quick-phrase-use").allTextContents())
    === JSON.stringify(["続けてください", "テストを実行して"]));
await page.keyboard.press("Escape");

// 追加した2件目は後続テストの前提を崩さないよう片付ける
await page.click("#quick-phrases-open");
await page.locator(".quick-phrase-row", { hasText: "テストを実行して" })
  .locator(".quick-phrase-delete").click();
await page.keyboard.press("Escape");

await page.click("#quick-phrases-open");
await page.locator(".quick-phrase-actions button").first().click();
await page.fill("#quick-phrase-input", "テストも実行して");
await page.click("#quick-phrase-submit");
check("quick phrase can be edited",
  (await page.locator(".quick-phrase-use").allTextContents()).includes("テストも実行して"));
check("editing a phrase updates the bar",
  (await page.locator(".quick-phrase-chip").allTextContents()).includes("テストも実行して"));
await page.waitForFunction(
  () => {
    try { return JSON.parse(window.__savedSession).settings?.quickPhrases?.[0]?.text === "テストも実行して"; }
    catch { return false; }
  },
  undefined,
  { timeout: 5000 },
).catch(() => {});
const savedPhrase = await page.evaluate(() => JSON.parse(window.__savedSession).settings?.quickPhrases?.[0]);
// 保存単位は { text, repo? }。汎用（どのリポジトリでも出る）は repo を持たない
check("quick phrases persist in session settings",
  savedPhrase?.text === "テストも実行して" && savedPhrase?.repo === undefined,
  `saved=${JSON.stringify(savedPhrase)}`);

await page.locator(".quick-phrase-delete").click();
check("quick phrase can be deleted",
  (await page.locator(".quick-phrase-use").count()) === 0 && await page.locator("#quick-phrases-empty").isVisible());
check("quick phrase bar hides again when the last phrase is deleted",
  await page.locator("#quick-phrase-bar").isHidden());
await page.keyboard.press("Escape");
check("Escape closes quick phrases", await page.locator("#quick-phrases-overlay").isHidden());

// --- 51. 設定パネル: 歯車で開閉・テーマ5種・dark 選択中 ---
check("settings gear visible in sidebar foot",
  await page.locator("#sidebar-foot #settings-open").isVisible());
await page.click("#settings-open");
check("settings overlay opens", await page.locator("#settings-overlay").isVisible());
// 左ナビ + 右コンテンツの2ペイン構成。開いた直後はテーマセクションが選択されている
check("settings nav lists all sections with theme active",
  (await page.locator("#settings-nav .settings-nav-item").count()) === 7 &&
    await page.locator('#settings-nav .settings-nav-item[data-section="theme"]').evaluate(
      (el) => el.classList.contains("is-active")));
const themeBtns = await page.locator("#settings-themes .settings-choice").count();
check("5 theme presets listed", themeBtns === 5, `buttons=${themeBtns}`);
check("dark selected initially",
  await page.locator('#settings-themes .settings-choice[data-theme-id="dark"]').evaluate(
    (el) => el.classList.contains("is-selected")));

// --- 52. パネル表示中の打鍵がターミナルに流れない ---
const writesBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.type("leak", { delay: 15 });
const writesAfter = await page.evaluate(() => window.__ptyWrites.length);
check("typing in settings does not reach pty", writesAfter === writesBefore,
  `before=${writesBefore} after=${writesAfter}`);

// --- 53. Escape で閉じる → 再度開く ---
await page.keyboard.press("Escape");
check("Escape closes settings", await page.locator("#settings-overlay").isHidden());
await page.click("#settings-open");
await page.waitForTimeout(100);

// --- 54. Light テーマ: CSS 変数 + ペイン背景が変わり、保存される ---
await page.click('#settings-themes .settings-choice[data-theme-id="light"]');
await page.waitForTimeout(100);
const bgVar = await page.evaluate(() =>
  document.documentElement.style.getPropertyValue("--bg").trim());
check("light theme sets --bg", bgVar === "#f4f5f6", `--bg=${bgVar}`);
const paneBg = await page.locator(".pane").first().evaluate(
  (el) => getComputedStyle(el).backgroundColor);
check("pane background follows theme", paneBg === "rgb(255, 255, 255)", `bg=${paneBg}`);
await page.waitForFunction(
  () => {
    try { return JSON.parse(window.__savedSession).settings?.theme === "light"; }
    catch { return false; }
  },
  undefined,
  { timeout: 5000 },
).catch(() => {});
const savedTheme = await page.evaluate(() => JSON.parse(window.__savedSession).settings?.theme);
check("theme persisted in session settings", savedTheme === "light", `theme=${savedTheme}`);

// --- 55. 言語切替: English → 静的テキスト + 動的メニューが英語化、日本語へ戻せる ---
await page.click('#settings-nav .settings-nav-item[data-section="language"]');
await page.click('#settings-langs .settings-choice[data-lang="en"]');
await page.waitForTimeout(100);
const newTitleEn = await page.locator("#ws-new").getAttribute("title");
check("static title switches to English", (newTitleEn ?? "").includes("New session"),
  `title="${newTitleEn}"`);
check("html lang set to en",
  (await page.evaluate(() => document.documentElement.lang)) === "en");
// 動的生成メニュー（オーバーレイを閉じてから右クリック）
await page.keyboard.press("Escape");
await page.locator(".ws-item").first().click({ button: "right" });
await page.waitForTimeout(100);
const ctxTextsEn = await page.locator("#ctx-menu button").allTextContents();
check("context menu in English",
  !ctxTextsEn.includes("Create session") && ctxTextsEn.includes("Create group") && ctxTextsEn.includes("Copy session"),
  `text=${JSON.stringify(ctxTextsEn)}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
await page.click("#settings-open");
await page.click('#settings-nav .settings-nav-item[data-section="language"]');
await page.click('#settings-langs .settings-choice[data-lang="ja"]');
await page.waitForTimeout(100);
const newTitleJa = await page.locator("#ws-new").getAttribute("title");
check("switches back to Japanese", (newTitleJa ?? "").includes("新規セッション"),
  `title="${newTitleJa}"`);
await page.waitForFunction(
  () => {
    try { return JSON.parse(window.__savedSession).settings?.language === "ja"; }
    catch { return false; }
  },
  undefined,
  { timeout: 5000 },
).catch(() => {});
const savedLang = await page.evaluate(() => JSON.parse(window.__savedSession).settings?.language);
check("language persisted in session settings", savedLang === "ja", `language=${savedLang}`);

// --- 55b. 多言語: 全言語ボタンが並ぶ / 中国語へ切替 / RTL は dir=rtl / 日本語へ戻す ---
const langCodes = await page.$$eval("#settings-langs .settings-choice",
  (els) => els.map((el) => el.dataset.lang));
check("every supported language has a button",
  langCodes.length === 17 && ["en", "ja", "zh-Hans", "zh-Hant", "ko", "es", "pt-BR", "fr", "de",
    "it", "ru", "ar", "hi", "id", "vi", "th", "tr"].every((c) => langCodes.includes(c)),
  `codes=${JSON.stringify(langCodes)}`);
await page.click('#settings-langs .settings-choice[data-lang="zh-Hans"]');
await page.waitForTimeout(100);
const newTitleZh = await page.locator("#ws-new").getAttribute("title");
const zhDoc = await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir]);
check("switches to Simplified Chinese",
  (newTitleZh ?? "").includes("新建会话") && zhDoc[0] === "zh-Hans" && zhDoc[1] === "ltr",
  `title="${newTitleZh}" lang=${zhDoc[0]} dir=${zhDoc[1]}`);
await page.click('#settings-langs .settings-choice[data-lang="ar"]');
await page.waitForTimeout(100);
const arDoc = await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir]);
const arTitle = await page.locator("#ws-new").getAttribute("title");
check("Arabic switches the document to RTL",
  arDoc[0] === "ar" && arDoc[1] === "rtl" && (arTitle ?? "").includes("جلسة"),
  `lang=${arDoc[0]} dir=${arDoc[1]} title="${arTitle}"`);
await page.click('#settings-langs .settings-choice[data-lang="ja"]');
await page.waitForTimeout(100);
const backToJa = await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir]);
check("back to Japanese restores LTR", backToJa[0] === "ja" && backToJa[1] === "ltr",
  `lang=${backToJa[0]} dir=${backToJa[1]}`);

// --- 56. アップデート確認: 新版あり → 表示 + リリースページを開く ---
await page.evaluate(() => {
  window.__mockUpdateResult = {
    current: "0.2.0",
    latest: "v0.3.0",
    url: "https://github.com/saisai-web/PATerminal/releases/tag/v0.3.0",
  };
});
await page.click('#settings-nav .settings-nav-item[data-section="update"]');
await page.click("#settings-check-update");
await page.waitForTimeout(200);
const updNew = await page.locator("#settings-update-result").textContent();
check("new version detected", (updNew ?? "").includes("v0.3.0"), `result="${updNew}"`);
await page.click("#settings-open-release");
await page.waitForTimeout(100);
const openedUrl = await page.evaluate(() => (window.__openedUrls ?? [])[0]);
check("release page open requested",
  openedUrl === "https://github.com/saisai-web/PATerminal/releases/tag/v0.3.0",
  `url=${openedUrl}`);

// --- 57. アップデート確認: 最新 / 失敗 ---
await page.evaluate(() => {
  window.__mockUpdateResult = { current: "0.2.0", latest: "v0.2.0", url: null };
});
await page.click("#settings-check-update");
await page.waitForTimeout(200);
const updSame = await page.locator("#settings-update-result").textContent();
check("up-to-date shows current version", (updSame ?? "").includes("0.2.0"), `result="${updSame}"`);
await page.evaluate(() => {
  window.__mockUpdateResult = { error: "HTTP 404" };
});
await page.click("#settings-check-update");
await page.waitForTimeout(200);
const updErr = await page.locator("#settings-update-result").textContent();
check("check failure shown gracefully",
  (updErr ?? "").includes("確認できませんでした"), `result="${updErr}"`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// --- 57. セッション右クリックメニュー拡充: パスコピー / OS で表示 / 閉じる ---
const wsCountBefore57 = await page.locator(".ws-item").count();
await page.locator(".ws-item").first().click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "パスをコピー" }).click();
await page.waitForTimeout(150);
const wsCopied = await page.evaluate(() => navigator.clipboard.readText());
check("session ctx copies its cwd", wsCopied.startsWith("/"), `copied="${wsCopied}"`);

await page.locator(".ws-item").first().click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: /Finder で表示|ファイルマネージャーで表示/ }).click();
await page.waitForTimeout(150);
const wsRevealed = await page.evaluate(() => window.__revealedPaths ?? []);
check("session ctx reveals cwd in file manager",
  wsRevealed.length > 0 && String(wsRevealed[wsRevealed.length - 1]).startsWith("/"),
  `revealed=${JSON.stringify(wsRevealed)}`);

// Escape でセッションメニューが閉じる（入力欄以外にフォーカスがあっても）
await page.locator(".ws-item").first().click({ button: "right" });
await page.waitForTimeout(150);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check("Escape closes session context menu", (await page.locator("#ctx-menu").count()) === 0);

// 複製で1つ増やしてから右クリックメニューの「セッションを閉じる」で元に戻す
await page.locator(".ws-item").first().click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "セッションをコピー" }).click();
await page.waitForTimeout(400);
const wsCountDup57 = await page.locator(".ws-item").count();
await page.locator(".ws-item.is-active").click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "セッションを閉じる" }).click();
await page.waitForTimeout(400);
const wsCountAfter57 = await page.locator(".ws-item").count();
check("session ctx close removes the session",
  wsCountDup57 === wsCountBefore57 + 1 && wsCountAfter57 === wsCountBefore57,
  `before=${wsCountBefore57} dup=${wsCountDup57} after=${wsCountAfter57}`);

}
