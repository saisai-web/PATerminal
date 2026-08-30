export default async function (ctx) {
const { page, check, MOD, editPanesAfter } = ctx;
const treeRow = (path) => page.locator(`.exp-row[data-exp-path="${path}"]`);

// ============================================================
// エクスプローラーパネル（デフォルト表示・フォーカス中ペインの cwd に追従）
// ============================================================

// --- 30. 起動時にフォーカス中ペインの cwd が一度だけ自動表示されている ---
const expPath0 = await page.locator("#exp-path").textContent();
check("explorer auto-filled with focused pane cwd", expPath0 === "/home/user", `path="${expPath0}"`);
const rows0 = await page.locator(".exp-row").count();
check("listing shows dotfiles by default", rows0 === 6, `rows=${rows0}`); // .. + .config + big + proj + .hidden-file + readme.md
// 行間は詰める。当たり判定は名前を書いている範囲だけで、行の右の余白は一覧の余白扱い
const explorerRowBoxes = await page.locator(".exp-row").evaluateAll((rows) =>
  rows.map((row) => ({
    height: row.getBoundingClientRect().height,
    width: row.getBoundingClientRect().width,
  })));
check("file and folder rows are compact",
  explorerRowBoxes.length > 0 && explorerRowBoxes.every((b) => b.height <= 26),
  `heights=${JSON.stringify(explorerRowBoxes.map((b) => b.height))}`);
const explorerListWidth = await page.locator("#exp-list").evaluate((el) => el.clientWidth);
check("row hit area is limited to the name text",
  explorerRowBoxes.every((b) => b.width < explorerListWidth - 12),
  `widths=${JSON.stringify(explorerRowBoxes.map((b) => b.width))} list=${explorerListWidth}`);
// 名前より右の余白の右クリックはファイル選択ではなく「一覧の余白」= 表示中フォルダのメニュー
const fileRowBox = await page.locator(".exp-row.is-file", { hasText: "readme.md" }).boundingBox();
await page.mouse.click(fileRowBox.x + fileRowBox.width + 40, fileRowBox.y + fileRowBox.height / 2,
  { button: "right" });
await page.waitForTimeout(200);
check("right of the file name counts as blank area, not the file",
  (await page.locator(".exp-ctx-item", { hasText: "新しいフォルダを作成" }).count()) === 1 &&
    (await page.locator(".exp-ctx-item", { hasText: "表示・編集" }).count()) === 0);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const initialUpContext = await page.locator(".exp-row.has-path-context .exp-row-path").textContent();
check("parent row shows its destination path on the right",
  initialUpContext === "/home", `context="${initialUpContext}"`);

// パスはクリック可能な階層パンくず。祖先へ直接戻れる。
const crumbLabels = await page.locator("#exp-path .exp-path-part").allTextContents();
check("explorer path is a hierarchy breadcrumb",
  JSON.stringify(crumbLabels) === JSON.stringify(["/", "home", "user"]), JSON.stringify(crumbLabels));
await page.locator("#exp-path .exp-path-part", { hasText: "home" }).click();
await page.waitForTimeout(200);
check("breadcrumb navigates directly to an ancestor", (await page.locator("#exp-path").textContent()) === "/home");
await treeRow("/home/user").click();
await page.waitForTimeout(200);
check("folder row expands inline without replacing the previous folder",
  (await page.locator("#exp-path").textContent()) === "/home" &&
    (await treeRow("/home/user").getAttribute("aria-expanded")) === "true" &&
    (await treeRow("/home/user/proj").isVisible()),
  `path="${await page.locator("#exp-path").textContent()}"`);
await page.click("#exp-root");
await page.waitForTimeout(200);

// フォルダ作成と明示更新。外部で増えた項目も fs_list の再取得で検知する。
await page.locator("#exp-path .exp-path-part").first().click();
await page.waitForTimeout(200);
check("folder creation has no header controls",
  (await page.locator("#exp-mkdir").count()) === 0 &&
    (await page.locator("#exp-mkdir-form").count()) === 0);
await treeRow("/tmp").click({ button: "right" });
await page.waitForTimeout(200);
check("folder context menu offers child folder creation",
  await page.locator(".exp-ctx-item", { hasText: "新しいフォルダを作成" }).isVisible());
await page.locator(".exp-ctx-item", { hasText: "新しいフォルダを作成" }).click();
const mkdirInline = page.locator("#exp-list .exp-mkdir-row .exp-mkdir-input");
check("folder creation starts as an inline row in the listing",
  await mkdirInline.isVisible() && await mkdirInline.evaluate((el) => el === document.activeElement) &&
    (await page.locator("#exp-path").textContent()) === "/");
await mkdirInline.fill("created-here");
await mkdirInline.press("Enter");
await treeRow("/tmp/created-here").waitFor();
const createdDirs = await page.evaluate(() => window.__fsCreatedDirs);
check("explorer creates a folder and refreshes the listing",
  createdDirs.includes("/tmp/created-here"), JSON.stringify(createdDirs));

// Escape は一覧内の作成行だけを閉じ、空のフォルダを残さない。
await treeRow("/tmp").click({ button: "right" });
await page.locator(".exp-ctx-item", { hasText: "新しいフォルダを作成" }).click();
await page.locator(".exp-mkdir-input").fill("cancelled-folder");
await page.locator(".exp-mkdir-input").press("Escape");
const cancelledFolderCreated = await page.evaluate(() =>
  window.__fsCreatedDirs.includes("/tmp/cancelled-folder"));
check("Escape cancels inline folder creation",
  (await page.locator(".exp-mkdir-row").count()) === 0 && !cancelledFolderCreated);
await page.evaluate(() => window.__mockFsTree["/tmp"].push({ name: "external-new.txt", isDir: false }));
check("external entry is absent before refresh",
  (await page.locator(".exp-row", { hasText: "external-new.txt" }).count()) === 0);
await page.click("#exp-refresh");
await page.locator(".exp-row", { hasText: "external-new.txt" }).waitFor();
check("explorer refresh detects externally-created entries", true);
await page.evaluate(() => {
  window.__mockFsTree["/tmp"] = window.__mockFsTree["/tmp"].filter((entry) => entry.name !== "external-new.txt");
});
await page.click("#exp-root");
await page.waitForTimeout(200);

// --- 31. × で閉じてレイアウトが追従し、Files ボタンで開き直せる ---
const gridOpenW = (await page.locator("#grid").boundingBox()).width;
await page.click("#exp-close");
await page.waitForTimeout(300);
const gridClosedW = (await page.locator("#grid").boundingBox()).width;
check("× button closes explorer", await page.locator("#explorer").isHidden());
check("pane layout follows new width", gridClosedW - gridOpenW > 200,
  `grid ${Math.round(gridOpenW)}→${Math.round(gridClosedW)}px`);

// --- 31b. 閉じている間だけ右端に再オープンタブが出て、クリックで開き直せる ---
check("reopen tab appears while closed", await page.locator("#exp-reopen").isVisible());
await page.click("#exp-reopen");
await page.waitForTimeout(300);
check("reopen tab reopens explorer", await page.locator("#explorer").isVisible());
check("reopen tab hidden while open", await page.locator("#exp-reopen").isHidden());
await page.click("#exp-close");
await page.waitForTimeout(200);
await page.click("#explorer-toggle");
await page.waitForTimeout(300);
check("Files button reopens explorer", await page.locator("#explorer").isVisible());
const expPathReopen = await page.locator("#exp-path").textContent();
check("reopen syncs to focused pane cwd", expPathReopen === "/home/user", `path="${expPathReopen}"`);

// --- 32. ディレクトリはその場で開閉し、.. だけが表示起点を上へ移す ---
await treeRow("/home/user/proj").click();
await page.waitForTimeout(300);
const expPath1 = await page.locator("#exp-path").textContent();
check("click dir expands children while keeping the parent listing",
  expPath1 === "/home/user" &&
    (await treeRow("/home/user/proj").getAttribute("aria-expanded")) === "true" &&
    (await treeRow("/home/user/proj/src").isVisible()) &&
    (await treeRow("/home/user/readme.md").isVisible()),
  `path="${expPath1}"`);
await treeRow("/home/user/proj/src").click();
await page.waitForTimeout(200);
check("nested folders expand as a sub-tree",
  (await treeRow("/home/user/proj/src").getAttribute("aria-expanded")) === "true" &&
    (await treeRow("/home/user/proj").isVisible()));
await treeRow("/home/user/proj").click();
await page.waitForTimeout(150);
check("clicking an open folder collapses only its descendants",
  (await treeRow("/home/user/proj").getAttribute("aria-expanded")) === "false" &&
    (await treeRow("/home/user/proj/src").count()) === 0 &&
    (await treeRow("/home/user/proj").isVisible()));
await page.locator(".exp-row", { hasText: ".." }).click();
await page.waitForTimeout(200);
await page.locator(".exp-row", { hasText: ".." }).click();
await page.waitForTimeout(200);
await page.waitForTimeout(100);
const expPathRoot = await page.locator("#exp-path").textContent();
const upAtRoot = await page.locator(".exp-row", { hasText: ".." }).count();
check("'..' climbs to root", expPathRoot === "/", `path="${expPathRoot}"`);
check("no '..' above filesystem root", upAtRoot === 0);

// --- 33. cwd が変わらないフォーカス移動・打鍵では手動ナビゲート位置を保持する ---
// （追従は cwd の「変化」だけに反応する。同じ cwd の再通知で表示をリセットしない）
await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
await page.keyboard.type("x", { delay: 20 });
await page.waitForTimeout(200);
const expPathStay = await page.locator("#exp-path").textContent();
check("same-cwd focus/typing keeps manual browsing", expPathStay === "/", `path="${expPathStay}"`);

// --- 34. 権限エラーは表示のみ。アプリは落ちない ---
await page.locator(".exp-row.is-dir", { hasText: "forbidden" }).click();
await page.waitForTimeout(300);
const errShown = await page.locator(".exp-error").count();
const stillAlive = await page.locator(".pane").count();
check("permission error shown below the retained folder row, app alive",
  errShown === 1 && stillAlive === editPanesAfter && await treeRow("/forbidden").isVisible(),
  `errors=${errShown} panes=${stillAlive}`);

// --- 35. 巨大ディレクトリは500件で打ち切り ---
await treeRow("/home").click();
await page.waitForTimeout(200);
await treeRow("/home/user").click();
await page.waitForTimeout(200);
await treeRow("/home/user/big").click();
await page.waitForTimeout(500);
const bigRows = await page.locator('.exp-row[data-exp-parent="/home/user/big"]').count();
const truncNote = await page.locator(".exp-note").count();
check("huge directory is truncated inside its expanded branch", bigRows === 500 && truncNote === 1,
  `rows=${bigRows} note=${truncNote}`);
await page.click("#exp-root");
await page.waitForTimeout(200);

// --- 36. 隠しファイルはデフォルト表示。トグルで非表示にできる / ファイル行は無反応 ---
const dotRowsBefore = await page.locator(".exp-row", { hasText: ".config" }).count();
await page.click("#exp-hidden");
await page.waitForTimeout(200);
const dotRows = await page.locator(".exp-row", { hasText: ".config" }).count();
check("dotfiles shown by default, toggle hides them", dotRowsBefore === 1 && dotRows === 0,
  `before=${dotRowsBefore} after=${dotRows}`);
await page.click("#exp-hidden");
await page.waitForTimeout(200);
// --- 36a2. ファイルビューア: ファイル行クリック → モーダルで内容表示・編集・保存 ---
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click();
await page.waitForTimeout(200);
check("file click opens viewer modal", await page.locator("#file-overlay").isVisible());
const fileText0 = await page.locator("#file-body").inputValue();
check("viewer shows file content", fileText0 === "# readme\nhello\n", `text=${JSON.stringify(fileText0)}`);
const expPathFile = await page.locator("#exp-path").textContent();
check("explorer path unchanged by file click", expPathFile === "/home/user", `path="${expPathFile}"`);
check("save disabled while unchanged", await page.locator("#file-save").isDisabled());
await page.locator("#file-body").fill("# readme\nhello world\n");
check("editing enables save button", await page.locator("#file-save").isEnabled());
await page.locator("#file-body").press(`${MOD}+KeyS`);
await page.waitForTimeout(200);
const fsWrites1 = await page.evaluate(() => window.__fsWrites);
check("Cmd/Ctrl+S saves via fs_write",
  fsWrites1.length === 1 && fsWrites1[0].path === "/home/user/readme.md" &&
    fsWrites1[0].text === "# readme\nhello world\n",
  JSON.stringify(fsWrites1));
check("save disabled again after save", await page.locator("#file-save").isDisabled());
// 未保存の変更 → Escape 1回目は警告のみ、2回目で破棄して閉じる
await page.locator("#file-body").fill("# readme\ndirty\n");
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Escape with unsaved changes warns first",
  (await page.locator("#file-overlay").isVisible()) && (await page.locator("#file-note").isVisible()));
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("second Escape discards and closes viewer", await page.locator("#file-overlay").isHidden());
const fsWrites2 = await page.evaluate(() => window.__fsWrites.length);
check("discarded edit is not written", fsWrites2 === 1, `writes=${fsWrites2}`);
// クリーンな状態なら Escape 1回で閉じる（保存済み内容は次回も表示される）
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click();
await page.waitForTimeout(200);
const fileText1 = await page.locator("#file-body").inputValue();
check("viewer reflects saved content", fileText1 === "# readme\nhello world\n", `text=${JSON.stringify(fileText1)}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check("Escape closes clean viewer immediately", await page.locator("#file-overlay").isHidden());

// --- 36a3. 画像: 選択パスをターミナルへ入力 / エクスプローラー内でプレビュー ---
const imageWriteBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.evaluate(() => {
  window.__mockPickedImages = ["/home/user/photo one.png", "/tmp/screenshot.jpg"];
});
await page.click("#attach-image");
await page.waitForTimeout(200);
const imagePathWrites = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), imageWriteBefore);
check("image picker inserts quoted paths without running them",
  imagePathWrites === "'/home/user/photo one.png' '/tmp/screenshot.jpg' ",
  `sent=${JSON.stringify(imagePathWrites)}`);

// キャンセル時はターミナルへ何も送らない
await page.evaluate(() => { window.__mockPickedImages = null; });
const imageCancelBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.click("#attach-image");
await page.waitForTimeout(100);
check("canceling image picker leaves terminal input unchanged",
  (await page.evaluate(() => window.__ptyWrites.length)) === imageCancelBefore);

// 一覧へテスト画像を一時追加し、テキスト欄でなく画像要素を表示する
await page.evaluate(() => {
  window.__mockFsTree["/home/user"].push({ name: "photo.png", isDir: false });
});
await page.click("#exp-refresh");
await page.waitForTimeout(200);
await page.locator(".exp-row.is-file", { hasText: "photo.png" }).click();
await page.waitForFunction(() => document.querySelector("#file-image")?.naturalWidth === 1);
check("image file opens an inline preview",
  (await page.locator("#file-image").isVisible()) &&
    (await page.locator("#file-body").isHidden()) &&
    (await page.locator("#file-save").isHidden()));
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
await page.evaluate(() => {
  const entries = window.__mockFsTree["/home/user"];
  const index = entries.findIndex((entry) => entry.name === "photo.png");
  if (index >= 0) entries.splice(index, 1);
});
await page.click("#exp-refresh");
await page.waitForTimeout(200);

// --- 36b. 検索フィルタ: 名前で絞り込み / 該当なし表示 / Escape クリア / 展開時に解除 ---
await page.fill("#exp-filter", "proj");
await page.waitForTimeout(200);
const filteredRows = await page.locator(".exp-row").count(); // .. + proj
check("filter narrows listing", filteredRows === 2, `rows=${filteredRows}`);
await page.fill("#exp-filter", "no-such-name");
await page.waitForTimeout(500); // 配下検索（デバウンス 250ms）が終わってから判定する
const noMatch = await page.locator(".exp-note", { hasText: "該当なし" }).count();
check("filter shows no-match note", noMatch === 1, `notes=${noMatch}`);
await page.press("#exp-filter", "Escape");
await page.waitForTimeout(200);
const filterAfterEsc = await page.locator("#exp-filter").inputValue();
const rowsAfterEsc = await page.locator(".exp-row").count();
check("Escape clears filter", filterAfterEsc === "" && rowsAfterEsc === 6,
  `value="${filterAfterEsc}" rows=${rowsAfterEsc}`);
await page.fill("#exp-filter", "proj");
await page.waitForTimeout(200);
await treeRow("/home/user/proj").click();
await page.waitForTimeout(300);
const filterAfterNav = await page.locator("#exp-filter").inputValue();
check("opening a filtered folder clears the filter and reveals its children inline",
  filterAfterNav === "" && (await page.locator("#exp-path").textContent()) === "/home/user" &&
    await treeRow("/home/user/proj/main.ts").isVisible(),
  `value="${filterAfterNav}"`);
await page.click("#exp-root");
await page.waitForTimeout(300);

// --- 36b-2. 配下検索: サブフォルダのファイル / フォルダも見つかる ---
// /home/user で "main" → 直下に無く、proj/main.ts がヒットする
await page.fill("#exp-filter", "main");
await page.waitForTimeout(500);
const deepHead = await page.locator(".exp-search-head").count();
const deepRows = await page.locator(".exp-row-deep").count();
check("subfolder search finds nested file", deepHead === 1 && deepRows === 1,
  `head=${deepHead} rows=${deepRows} path=${await page.locator("#exp-path").getAttribute("title")}` +
  ` filter="${await page.locator("#exp-filter").inputValue()}"`);
const deepPath = await page.locator(".exp-row-deep .exp-row-path").first().textContent();
check("subfolder hit shows its relative folder", deepPath === "proj", `path=${deepPath}`);
// 配下ヒットのファイルをクリック → そのファイルのビューアが開く
await page.locator(".exp-row-deep").first().click();
await page.waitForTimeout(300);
const deepFileText = await page.locator("#file-body").inputValue();
check("clicking a subfolder hit opens that file",
  (await page.locator("#file-overlay").isVisible()) && deepFileText === "console.log(1);\n",
  `text=${JSON.stringify(deepFileText)}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
// 配下のフォルダはクリックで祖先ごとツリー展開する（表示起点は動かさない）
await page.fill("#exp-filter", "src");
await page.waitForTimeout(500);
await page.locator(".exp-row-deep.is-dir", { hasText: "src" }).click();
await page.waitForTimeout(300);
const afterDeepNav = await page.locator("#exp-path").getAttribute("title");
check("clicking a subfolder dir reveals it in the inline tree",
  afterDeepNav === "/home/user" &&
    (await treeRow("/home/user/proj").getAttribute("aria-expanded")) === "true" &&
    (await treeRow("/home/user/proj/src").getAttribute("aria-expanded")) === "true",
  `path=${afterDeepNav}`);
check("subfolder reveal clears the search", (await page.locator("#exp-filter").inputValue()) === "");
// 隠しファイルを非表示にすると配下ヒットからも消える
await page.click("#exp-root");
await page.waitForTimeout(300);
await page.fill("#exp-filter", "hidden");
await page.waitForTimeout(500);
const hiddenDirect = await page.locator(".exp-row", { hasText: ".hidden-file" }).count();
await page.click("#exp-hidden");
await page.waitForTimeout(500);
const hiddenAfter = await page.locator(".exp-row", { hasText: ".hidden-file" }).count();
check("hidden toggle applies to search results", hiddenDirect === 1 && hiddenAfter === 0,
  `before=${hiddenDirect} after=${hiddenAfter}`);
await page.click("#exp-hidden");
await page.press("#exp-filter", "Escape");
await page.waitForTimeout(300);

// --- 36c. ⌂ ボタン: 開いた枝を閉じてフォーカス中ペインの cwd を再表示する ---
await treeRow("/home/user/proj").click();
await page.waitForTimeout(300);
await treeRow("/home/user/proj/src").click();
await page.waitForTimeout(300);
const expPathDeep = await page.locator("#exp-path").textContent();
const nestedBeforeRoot = await treeRow("/home/user/proj/src").isVisible();
await page.click("#exp-root");
await page.waitForTimeout(300);
const expPathRootBtn = await page.locator("#exp-path").textContent();
check("root button restores a collapsed tree at the focused pane cwd",
  expPathDeep === "/home/user" && nestedBeforeRoot && expPathRootBtn === "/home/user" &&
    (await treeRow("/home/user/proj/src").count()) === 0,
  `deep="${expPathDeep}" back="${expPathRootBtn}"`);
// サイドバーの cwd は表示幅にかかわらず末尾2階層だけを残す
const longSidebarPath = "/Users/example/development/clients/very-long-project/packages/terminal/src";
await page.evaluate((path) => window.__ptyPushAll(`\x1b]7;file://${path}\x1b\\`), longSidebarPath);
await page.waitForTimeout(300);
const sidebarPathInfo = await page.locator(".ws-item.is-active .ws-sub").evaluate((el) => {
  const style = getComputedStyle(el);
  return {
    text: el.textContent ?? "",
    title: el.getAttribute("title"),
    height: el.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(style.lineHeight),
  };
});
check("sidebar path keeps only its final two components on one line",
  sidebarPathInfo.text === ".../terminal/src" &&
    sidebarPathInfo.title === longSidebarPath &&
    sidebarPathInfo.height <= sidebarPathInfo.lineHeight + 1,
  `text="${sidebarPathInfo.text}" height=${sidebarPathInfo.height}`);
const longPathPinContext = await page.locator(".exp-session-row .exp-row-path").textContent();
check("session-cwd pin keeps the final two parent components",
  longPathPinContext === "…/packages/terminal", `context="${longPathPinContext}"`);
// 名前と長い親パスが競合しても、名前を残して右側の親パスから隠す
const longFilesName = "favorite-name-that-must-not-be-hidden-by-context";
const longFilesPath = `/Users/example/development/extraordinarilylongparentdirectoryname/anotherextraordinarilylongdirectoryname/${longFilesName}`;
await page.evaluate((path) => window.__ptyPushAll(`\x1b]7;file://${path}\x1b\\`), longFilesPath);
await page.waitForTimeout(300);
const longFilesContext = "…/extraordinarilylongparentdirectoryname/anotherextraordinarilylongdirectoryname";
const longFilesContextBoxes = await page
  .locator(".exp-session-row .exp-row-path, .exp-row.has-path-context .exp-row-path")
  .evaluateAll((els) => els.map((el) => {
    const style = getComputedStyle(el);
    return {
      text: el.textContent ?? "",
      title: el.getAttribute("title"),
      whiteSpace: style.whiteSpace,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      clientHeight: el.clientHeight,
      lineHeight: Number.parseFloat(style.lineHeight),
    };
  }));
check("Files keeps the long path on one line and ellipsizes the overflow",
  longFilesContextBoxes.length === 2 && longFilesContextBoxes.every((box) =>
    box.text === longFilesContext &&
      box.whiteSpace === "nowrap" &&
      box.clientHeight <= box.lineHeight + 1 && // 1行のまま
      box.scrollWidth > box.clientWidth + 1), // 収まらない分は … で省かれている
  JSON.stringify(longFilesContextBoxes));
check("Files keeps the full path in the tooltip",
  longFilesContextBoxes.every((box) => (box.title ?? "").endsWith("anotherextraordinarilylongdirectoryname")),
  JSON.stringify(longFilesContextBoxes.map((box) => box.title)));
await page.click("#exp-fav");
await page.waitForTimeout(200);
const favoriteNamePriority = await page
  .locator(".exp-session-row, .exp-fav-row:not(.exp-session-row)")
  .evaluateAll((rows) => rows.map((row) => {
    const name = row.querySelector(".exp-fav-name");
    const context = row.querySelector(".exp-row-path");
    return {
      name: name?.textContent ?? "",
      nameWidth: name?.clientWidth ?? 0,
      contextWidth: context?.clientWidth ?? 0,
    };
  }));
check("Files hides parent context before current/favorite names",
  favoriteNamePriority.length === 2 && favoriteNamePriority.every((box) =>
    box.name.endsWith(longFilesName) &&
      box.nameWidth > 0 &&
      box.contextWidth <= 2),
  JSON.stringify(favoriteNamePriority));
await page.click("#exp-fav");
await page.waitForTimeout(200);
// シェル内で cd すると（OSC 7）エクスプローラーの表示も追従してそこへ移る
await page.evaluate(() => window.__ptyPushAll("\x1b]7;file:///tmp\x1b\\"));
await page.waitForTimeout(300);
const cwdLabelAfterCd = await page
  .locator(".workspace-layer:not([hidden]) .pane-cwd").first().textContent();
const expPathFollowCd = await page.locator("#exp-path").textContent();
check("explorer follows shell cd (OSC 7)",
  cwdLabelAfterCd === "/tmp" && expPathFollowCd === "/tmp",
  `cwd="${cwdLabelAfterCd}" path="${expPathFollowCd}"`);
// それでも ⌂ は「ターミナルを開いた時のディレクトリ」に戻る（現在 cwd ではない）
await page.click("#exp-root");
await page.waitForTimeout(300);
const expPathAfterCd = await page.locator("#exp-path").textContent();
check("root button uses spawn-time dir, not current cwd",
  expPathAfterCd === "/home/user", `back="${expPathAfterCd}"`);

// --- 36d. お気に入り: ☆ 登録 → 一覧表示 → クリックで移動 → 保存 → × 削除 ---
// お気に入り欄の先頭には「セッションの現在地」ピンが常設される（cd 追従、ここでは /tmp）
const sessPinRows = await page.locator(".exp-session-row").count();
const sessPinName = await page.locator(".exp-session-row .exp-fav-name").textContent();
const sessPinContext = await page.locator(".exp-session-row .exp-row-path").textContent();
check("session-cwd pin shown in favorites area",
  sessPinRows === 1 && sessPinName === "➤ tmp" && sessPinContext === "/" &&
    (await page.locator("#exp-favs").isVisible()),
  `rows=${sessPinRows} name="${sessPinName}" context="${sessPinContext}"`);
await page.locator(".exp-session-row").click();
await page.waitForTimeout(300);
const sessPinNav = await page.locator("#exp-path").textContent();
check("session-cwd pin navigates to current cwd", sessPinNav === "/tmp", `path="${sessPinNav}"`);
await page.click("#exp-root");
await page.waitForTimeout(300);
await page.click("#exp-fav");
await page.waitForTimeout(200);
const favBtnOn = await page.locator("#exp-fav").textContent();
const favRows = await page.locator(".exp-fav-row:not(.exp-session-row)").count();
const favContext = await page.locator(".exp-fav-row:not(.exp-session-row) .exp-row-path").textContent();
const favRowHeight = await page.locator(".exp-fav-row:not(.exp-session-row)").evaluate((row) =>
  row.getBoundingClientRect().height);
check("star button adds favorite with parent path context",
  favBtnOn === "★" && favRows === 1 && favContext === "/home" && favRowHeight <= 26,
  `btn="${favBtnOn}" rows=${favRows} context="${favContext}" height=${favRowHeight}`);
await page.locator(".exp-session-row").click();
await page.waitForTimeout(300);
const favBtnOff = await page.locator("#exp-fav").textContent();
check("star button reflects non-favorited dir", favBtnOff === "☆", `btn="${favBtnOff}"`);
await page.locator(".exp-fav-row", { hasText: "user" }).click();
await page.waitForTimeout(300);
const favNavPath = await page.locator("#exp-path").textContent();
check("favorite row navigates to its path", favNavPath === "/home/user", `path="${favNavPath}"`);
await page.waitForFunction(
  () => {
    try {
      return JSON.parse(window.__savedSession ?? "").explorer?.favorites?.includes("/home/user");
    } catch {
      return false;
    }
  },
  undefined,
  { timeout: 8000 },
).catch(() => {});
const favSaved = JSON.parse(await page.evaluate(() => window.__savedSession));
check("favorites persisted in session file", favSaved.explorer?.favorites?.[0] === "/home/user",
  `favorites=${JSON.stringify(favSaved.explorer?.favorites)}`);
await page.locator(".exp-fav-del").click();
await page.waitForTimeout(200);
const favRowsAfterDel = await page.locator(".exp-fav-row:not(.exp-session-row)").count();
const favBtnAfterDel = await page.locator("#exp-fav").textContent();
check("× removes favorite and clears star",
  favRowsAfterDel === 0 && favBtnAfterDel === "☆" &&
    (await page.locator(".exp-session-row").count()) === 1, // ピンは残る
  `rows=${favRowsAfterDel} btn="${favBtnAfterDel}"`);
await page.click("#exp-root");
await page.waitForTimeout(300);

// --- 36e. 右クリックメニュー: 移動 / お気に入り追加・解除 / Escape で閉じる ---
await page.locator(".exp-row.is-dir", { hasText: "proj" }).click({ button: "right" });
await page.waitForTimeout(200);
const ctxVisible = await page.locator("#exp-ctx").isVisible();
const ctxItems = await page.locator(".exp-ctx-item").count();
const dirCtxCanMkdir = await page.locator(".exp-ctx-item", { hasText: "新しいフォルダを作成" }).isVisible();
const dirCtxCanImport = await page.locator(".exp-ctx-item", { hasText: "ファイルをインポート…" }).isVisible() &&
  await page.locator(".exp-ctx-item", { hasText: "フォルダをインポート…" }).isVisible();
check("right-click on dir row opens context menu", ctxVisible && ctxItems === 10 && dirCtxCanMkdir && dirCtxCanImport,
  `visible=${ctxVisible} items=${ctxItems}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check("Escape closes context menu", await page.locator("#exp-ctx").isHidden());
await page.locator(".exp-row.is-dir", { hasText: "proj" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "お気に入りに追加" }).click();
await page.waitForTimeout(200);
const ctxFavRows = await page.locator(".exp-fav-row:not(.exp-session-row)").count();
check("context menu adds favorite without navigating",
  ctxFavRows === 1 && (await page.locator("#exp-ctx").isHidden()) &&
    (await page.locator("#exp-path").textContent()) === "/home/user",
  `favRows=${ctxFavRows}`);
// 「ターミナルをここへ移動」= フォーカス中ペインに cd を打ち込む（表示は動かさない）
const cdWritesBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".exp-row.is-dir", { hasText: "proj" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "ターミナルをここへ移動" }).click();
await page.waitForTimeout(300);
const ctxNavPath = await page.locator("#exp-path").textContent();
const cdWrites = await page.evaluate((n) => window.__ptyWrites.slice(n), cdWritesBefore);
const cdSent = cdWrites.map((x) => x.data).join("");
check("context menu cds the focused terminal",
  cdSent === "cd '/home/user/proj'\r" && ctxNavPath === "/home/user",
  `sent=${JSON.stringify(cdSent)} path="${ctxNavPath}"`);
await page.locator(".exp-fav-row", { hasText: "proj" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "お気に入りから外す" }).click();
await page.waitForTimeout(200);
const ctxFavRowsAfter = await page.locator(".exp-fav-row:not(.exp-session-row)").count();
check("context menu on favorite row removes it", ctxFavRowsAfter === 0, `rows=${ctxFavRowsAfter}`);
await page.click("#exp-root");
await page.waitForTimeout(300);

// --- 36f. 右クリックメニュー拡充: コピー / OS で表示 / 新規ペイン / ファイル行 ---
await page.locator(".exp-row.is-dir", { hasText: "proj" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "パスをコピー" }).click();
await page.waitForTimeout(200);
const copiedDir = await page.evaluate(() => navigator.clipboard.readText());
check("dir ctx copies path to clipboard", copiedDir === "/home/user/proj", `copied="${copiedDir}"`);

await page.locator(".exp-row.is-dir", { hasText: "proj" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: /Finder で表示|ファイルマネージャーで表示/ }).click();
await page.waitForTimeout(200);
const revealedDirs = await page.evaluate(() => window.__revealedPaths ?? []);
check("dir ctx calls reveal_path", revealedDirs.length === 1 && revealedDirs[0] === "/home/user/proj",
  `revealed=${JSON.stringify(revealedDirs)}`);

// 「新規ペインで開く」= そのフォルダを cwd にフォーカス中ペインを分割
const panesBeforeCtx = await page.locator(".workspace-layer:not([hidden]) .pane").count();
await page.locator(".exp-row.is-dir", { hasText: "proj" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "新規ペインで開く" }).click();
await page.waitForTimeout(400);
const panesAfterCtx = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const ctxSpawn = await page.evaluate(() => window.__ptySpawns[window.__ptySpawns.length - 1]);
check("dir ctx opens new pane at folder",
  panesAfterCtx === panesBeforeCtx + 1 && ctxSpawn.cwd === "/home/user/proj",
  `panes=${panesBeforeCtx}->${panesAfterCtx} cwd=${ctxSpawn.cwd}`);
// 後続テストの前提を崩さないよう追加ペインは閉じて戻す
await page.locator(".workspace-layer:not([hidden]) .pane .pane-close").last().click();
await page.waitForTimeout(300);
await page.click("#exp-root");
await page.waitForTimeout(300);

// ファイル行の右クリック: 開く / OS で表示 / コピー系（フォルダとは項目が違う）
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click({ button: "right" });
await page.waitForTimeout(200);
const fileCtxItems = await page.locator(".exp-ctx-item").count();
const fileCtxCanMkdir = await page.locator(".exp-ctx-item", { hasText: "新しいフォルダを作成" }).isVisible();
const fileCtxCanImport = await page.locator(".exp-ctx-item", { hasText: "ファイルをインポート…" }).isVisible() &&
  await page.locator(".exp-ctx-item", { hasText: "フォルダをインポート…" }).isVisible();
check("right-click on file row opens context menu",
  (await page.locator("#exp-ctx").isVisible()) && fileCtxItems === 11 && fileCtxCanMkdir && fileCtxCanImport,
  `items=${fileCtxItems}`);
const importWritesBefore = await page.evaluate(() => window.__ptyWrites.length);
const fileImportsBefore = await page.evaluate(() => window.__fsImports.length);
await page.evaluate(() => {
  window.__mockPickedFiles = ["/tmp/import note.md", "/tmp/data.csv"];
});
await page.locator(".exp-ctx-item", { hasText: "ファイルをインポート…" }).click();
await page.waitForTimeout(300);
const fileImportState = await page.evaluate((before) => ({
  imports: window.__fsImports.slice(before),
  dialog: window.__dialogOpenCalls.at(-1),
  writes: window.__ptyWrites.length,
}), fileImportsBefore);
check("file-row import copies selected files into its parent without terminal input",
  fileImportState.imports.length === 1 &&
    fileImportState.imports[0].destDir === "/home/user" &&
    fileImportState.imports[0].sources.join(",") === "/tmp/import note.md,/tmp/data.csv" &&
    fileImportState.dialog?.directory === false &&
    fileImportState.dialog?.multiple === true &&
    fileImportState.writes === importWritesBefore &&
    (await treeRow("/home/user/import note.md").count()) === 1 &&
    (await treeRow("/home/user/data.csv").count()) === 1,
  JSON.stringify(fileImportState));
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "表示・編集" }).click();
await page.waitForTimeout(200);
check("file ctx view/edit opens viewer modal", await page.locator("#file-overlay").isVisible());
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "開く（既定のアプリ）" }).click();
await page.waitForTimeout(200);
const openedPaths = await page.evaluate(() => window.__openedPaths ?? []);
check("file ctx opens with default app",
  openedPaths.length === 1 && openedPaths[0] === "/home/user/readme.md",
  `opened=${JSON.stringify(openedPaths)}`);
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "ファイル名をコピー" }).click();
await page.waitForTimeout(200);
const copiedName = await page.evaluate(() => navigator.clipboard.readText());
check("file ctx copies file name", copiedName === "readme.md", `copied="${copiedName}"`);

// ファイル右クリックの「ターミナルをここへ移動」= ファイルの親フォルダへ cd
const fileCdBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "ターミナルをここへ移動" }).click();
await page.waitForTimeout(300);
const fileCdSent = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), fileCdBefore);
check("file ctx cds terminal to file's folder", fileCdSent === "cd '/home/user'\r",
  `sent=${JSON.stringify(fileCdSent)}`);

// ファイル右クリックからも「新規セッションで開く」= ファイルの親フォルダで開く
await page.locator(".exp-row.is-file", { hasText: "readme.md" }).click({ button: "right" });
await page.waitForTimeout(200);
const wsCountBeforeFile = await page.locator(".ws-item").count();
await page.locator(".exp-ctx-item", { hasText: "新規セッションで開く" }).click();
await page.waitForTimeout(400);
const lastSpawnFile = await page.evaluate(() => window.__ptySpawns.at(-1));
const wsCountAfterFile = await page.locator(".ws-item").count();
check("file ctx opens session at file's folder",
  wsCountAfterFile === wsCountBeforeFile + 1 && lastSpawnFile.cwd === "/home/user",
  `cwd="${lastSpawnFile.cwd}" items ${wsCountBeforeFile}→${wsCountAfterFile}`);
// 後始末: 作ったセッション（アクティブ）を閉じ、追従で動いた表示を ⌂ で戻す
const fileSessItem = page.locator(".ws-item.is-active");
await fileSessItem.hover();
await fileSessItem.locator(".ws-close").click();
await page.waitForTimeout(300);
await page.click("#exp-root");
await page.waitForTimeout(300);

// 一覧の余白（行の外）を右クリック → 表示中フォルダのメニュー（ここでセッションを開く）
const expListBox = await page.locator("#exp-list").boundingBox();
await page.mouse.click(expListBox.x + expListBox.width / 2, expListBox.y + expListBox.height - 6,
  { button: "right" });
await page.waitForTimeout(200);
check("blank-area right-click opens folder menu", await page.locator("#exp-ctx").isVisible());
const folderImportsBefore = await page.evaluate(() => window.__fsImports.length);
await page.evaluate(() => {
  window.__mockPickedDirectory = ["/tmp/incoming-folder"];
  window.__mockImportDirs = ["/tmp/incoming-folder"];
});
await page.locator(".exp-ctx-item", { hasText: "フォルダをインポート…" }).click();
await page.waitForTimeout(300);
const folderImportState = await page.evaluate((before) => ({
  imports: window.__fsImports.slice(before),
  dialog: window.__dialogOpenCalls.at(-1),
}), folderImportsBefore);
check("blank-area import copies selected folders into the current folder",
  folderImportState.imports.length === 1 &&
    folderImportState.imports[0].destDir === "/home/user" &&
    folderImportState.imports[0].sources.join(",") === "/tmp/incoming-folder" &&
    folderImportState.dialog?.directory === true &&
    folderImportState.dialog?.multiple === true &&
    await treeRow("/home/user/incoming-folder").isVisible(),
  JSON.stringify(folderImportState));
await page.mouse.click(expListBox.x + expListBox.width / 2, expListBox.y + expListBox.height - 6,
  { button: "right" });
await page.waitForTimeout(200);
const wsCountBeforeHere = await page.locator(".ws-item").count();
await page.locator(".exp-ctx-item", { hasText: "新規セッションで開く" }).click();
await page.waitForTimeout(400);
const lastSpawnHere = await page.evaluate(() => window.__ptySpawns.at(-1));
const wsCountAfterHere = await page.locator(".ws-item").count();
check("open session here from blank right-click",
  wsCountAfterHere === wsCountBeforeHere + 1 && lastSpawnHere.cwd === "/home/user",
  `cwd="${lastSpawnHere.cwd}" items ${wsCountBeforeHere}→${wsCountAfterHere}`);
// 後始末: 作ったセッション（アクティブ）を閉じる。セッション切替で explorer が
// フォーカス先の cwd（過去テストの OSC 7 で /tmp になっている）へ追従するので ⌂ で戻す
const hereItem = page.locator(".ws-item.is-active");
await hereItem.hover();
await hereItem.locator(".ws-close").click();
await page.waitForTimeout(300);
await page.click("#exp-root");
await page.waitForTimeout(300);

// --- 36g. 削除（ゴミ箱へ移動）と DnD 移動 ---
await page.evaluate(() => {
  window.__mockFsTree["/home/user"].push(
    { name: "trash-me", isDir: true },
    { name: "dest-dir", isDir: true },
    { name: "move-me.txt", isDir: false },
  );
  window.__mockFsTree["/home/user/trash-me"] = [];
  window.__mockFsTree["/home/user/dest-dir"] = [];
});
await page.click("#exp-refresh");
await treeRow("/home/user/trash-me").waitFor();
// フォルダの右クリック →「ゴミ箱に入れる」= fs_trash（OS のゴミ箱なので確認なし・復元可能）
await treeRow("/home/user/trash-me").click({ button: "right" });
await page.waitForTimeout(200);
await page.locator(".exp-ctx-item", { hasText: "ゴミ箱に入れる" }).click();
await page.waitForTimeout(300);
const trashedPaths = await page.evaluate(() => window.__fsTrashed);
check("folder ctx moves it to the OS trash and refreshes the listing",
  trashedPaths.includes("/home/user/trash-me") &&
    (await treeRow("/home/user/trash-me").count()) === 0,
  JSON.stringify(trashedPaths));
// `..`・お気に入り・パンくず由来のメニューには削除を出さない（表示中の祖先を消せてしまう）
await page.locator(".exp-row", { hasText: ".." }).click({ button: "right" });
await page.waitForTimeout(200);
check("parent row menu has no trash item",
  (await page.locator(".exp-ctx-item", { hasText: "ゴミ箱に入れる" }).count()) === 0);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
// ファイル行をフォルダ行へドラッグ&ドロップ → fs_move で移動し、両方の一覧に反映される
const dndSrcBox = await page.locator(".exp-row.is-file", { hasText: "move-me.txt" }).boundingBox();
const dndDstBox = await treeRow("/home/user/dest-dir").boundingBox();
await page.mouse.move(dndSrcBox.x + 8, dndSrcBox.y + dndSrcBox.height / 2);
await page.mouse.down();
await page.mouse.move(dndDstBox.x + 8, dndDstBox.y + dndDstBox.height / 2, { steps: 10 });
await page.mouse.move(dndDstBox.x + 10, dndDstBox.y + dndDstBox.height / 2);
await page.mouse.up();
await page.waitForTimeout(400);
const dndMoves = await page.evaluate(() => window.__fsMoves);
check("drag & drop moves a file into a folder",
  dndMoves.some((m) => m.src === "/home/user/move-me.txt" && m.destDir === "/home/user/dest-dir") &&
    (await page.locator(".exp-row.is-file", { hasText: "move-me.txt" }).count()) === 0,
  JSON.stringify(dndMoves));
await treeRow("/home/user/dest-dir").click();
await page.waitForTimeout(300);
check("moved file appears inside the destination folder",
  await treeRow("/home/user/dest-dir/move-me.txt").isVisible());
// 後始末: 追加したエントリを消して表示を戻す（⌂ はツリーの展開状態もリセットする）
await page.evaluate(() => {
  window.__mockFsTree["/home/user"] =
    window.__mockFsTree["/home/user"].filter((entry) => entry.name !== "dest-dir");
  delete window.__mockFsTree["/home/user/dest-dir"];
});
await page.click("#exp-root");
await page.waitForTimeout(300);

// --- 37. 新規ペイン: 表示中パスを cwd に現在セッション内で分割 ---
await page.evaluate(() => window.__ptyPushAll("\x1b]7;file:///home/user/proj\x1b\\"));
await page.waitForTimeout(300);
check("terminal cwd change can still replace the explorer tree root",
  (await page.locator("#exp-path").textContent()) === "/home/user/proj");
const panesBeforeExp = await page.locator(".workspace-layer:not([hidden]) .pane").count();
await page.click("#exp-new-pane");
await page.waitForTimeout(400);
const panesAfterExp = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const lastSpawn1 = await page.evaluate(() => window.__ptySpawns.at(-1));
check("explorer new-pane splits in current session", panesAfterExp === panesBeforeExp + 1,
  `panes ${panesBeforeExp}→${panesAfterExp}`);
check("new pane cwd = shown path", lastSpawn1.cwd === "/home/user/proj", `cwd="${lastSpawn1.cwd}"`);

// --- 40. 新規セッション: 表示中パスを cwd に、ディレクトリ名で作成 ---
await page.click("#exp-new-session");
await page.waitForTimeout(400);
const newSessName = await page.locator(".ws-item.is-active .ws-name").textContent();
const lastSpawn2 = await page.evaluate(() => window.__ptySpawns.at(-1));
check("explorer new-session named after directory", newSessName === "proj", `name="${newSessName}"`);
check("new session cwd = shown path", lastSpawn2.cwd === "/home/user/proj", `cwd="${lastSpawn2.cwd}"`);

// --- 41. グループ化してもブロードキャストはアクティブセッション内に閉じる ---
await page.locator(".ws-item", { hasText: "api" }).locator(".ws-name").click();
await page.waitForTimeout(300);
await page.click("#broadcast");
await page.waitForSelector("#broadcast-overlay:not([hidden])", { timeout: 3000 });
await page.click("#broadcast-start"); // 送信先を足さない = セッション内で閉じる
await page.waitForTimeout(100);
await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
const grpPaneCount = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const grpBcastBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("q");
await page.waitForTimeout(150);
const grpBcastWrites = await page.evaluate((n) => window.__ptyWrites.slice(n), grpBcastBefore);
const grpBcastIds = new Set(grpBcastWrites.filter((x) => x.data === "q").map((x) => x.id));
check("broadcast stays inside active session even when grouped", grpBcastIds.size === grpPaneCount,
  `panes hit=${grpBcastIds.size}/${grpPaneCount}`);
await page.click("#broadcast");

// --- 40. Cmd/Ctrl+E で開閉トグル（レイアウトも戻る） ---
await page.keyboard.press(`${MOD}+KeyE`);
await page.waitForTimeout(400);
const expClosed = await page.locator("#explorer").isHidden();
const gridRestored = (await page.locator("#grid").boundingBox()).width;
check("Cmd/Ctrl+E closes explorer", expClosed);
check("layout restored after close", Math.abs(gridRestored - gridClosedW) < 2,
  `grid=${Math.round(gridRestored)}px`);
await page.keyboard.press(`${MOD}+KeyE`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+E reopens explorer", await page.locator("#explorer").isVisible());

// --- 41. ハンドルドラッグで幅変更 / 右へ押し込むと閉じる / ダブルクリックで既定幅 ---
const expBox0 = await page.locator("#explorer").boundingBox();
const gridBeforeResize = (await page.locator("#grid").boundingBox()).width;
const handle0 = await page.locator("#exp-resize").boundingBox();
const hy = handle0.y + 100;
await page.mouse.move(handle0.x + 3, hy);
await page.mouse.down();
await page.mouse.move(handle0.x - 140, hy, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const expBoxWide = await page.locator("#explorer").boundingBox();
check("drag handle widens explorer", expBoxWide.width - expBox0.width > 100,
  `${Math.round(expBox0.width)}→${Math.round(expBoxWide.width)}px`);
const gridNarrowW = (await page.locator("#grid").boundingBox()).width;
const gridShrunk = gridBeforeResize - gridNarrowW;
const expGrown = expBoxWide.width - expBox0.width;
check("grid follows explorer resize", Math.abs(gridShrunk - expGrown) < 3,
  `grid -${Math.round(gridShrunk)}px / explorer +${Math.round(expGrown)}px`);
check("no stuck body.dragging after explorer resize",
  !(await page.evaluate(() => document.body.classList.contains("dragging"))));
const handle1 = await page.locator("#exp-resize").boundingBox();
await page.mouse.move(handle1.x + 3, hy);
await page.mouse.down();
await page.mouse.move(handle1.x + expBoxWide.width + 60, hy, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
check("push-in closes explorer", await page.locator("#explorer").isHidden());
check("reopen tab visible after push-close", await page.locator("#exp-reopen").isVisible());
await page.click("#exp-reopen");
await page.waitForTimeout(300);
await page.dblclick("#exp-resize");
await page.waitForTimeout(300);
const expBoxReset = await page.locator("#explorer").boundingBox();
check("dblclick resets width to default", Math.abs(expBoxReset.width - 260) < 2,
  `width=${Math.round(expBoxReset.width)}px`);

// --- 42. サイドバーも « ボタン / 左端タブ / Cmd/Ctrl+B の1クリックでたためる ---
const sidebarW = (await page.locator("#sidebar").boundingBox()).width;
const gridSidebarOpen = (await page.locator("#grid").boundingBox()).width;
await page.click("#sidebar-collapse");
await page.waitForTimeout(300);
check("« button collapses sidebar", await page.locator("#sidebar").isHidden());
check("sidebar reopen tab appears while collapsed",
  await page.locator("#sidebar-reopen").isVisible());
const gridSidebarClosed = (await page.locator("#grid").boundingBox()).width;
check("pane layout follows collapsed sidebar",
  gridSidebarClosed - gridSidebarOpen > sidebarW - 40,
  `grid ${Math.round(gridSidebarOpen)}→${Math.round(gridSidebarClosed)}px`);
await page.click("#sidebar-reopen");
await page.waitForTimeout(300);
check("sidebar reopen tab reopens sidebar", await page.locator("#sidebar").isVisible());
check("sidebar reopen tab hidden while open", await page.locator("#sidebar-reopen").isHidden());
check("layout restored after sidebar reopen",
  Math.abs((await page.locator("#grid").boundingBox()).width - gridSidebarOpen) < 2);
await page.keyboard.press(`${MOD}+KeyB`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+B collapses sidebar", await page.locator("#sidebar").isHidden());
await page.keyboard.press(`${MOD}+KeyB`);
await page.waitForTimeout(300);
check("Cmd/Ctrl+B reopens sidebar", await page.locator("#sidebar").isVisible());

// --- 43. サイドバーも右端ハンドルのドラッグで幅変更 / 左へ押し込むとたたむ / dblclick で既定幅 ---
const sbBox0 = await page.locator("#sidebar").boundingBox();
const gridBeforeSbResize = (await page.locator("#grid").boundingBox()).width;
const sbHandle0 = await page.locator("#sidebar-resize").boundingBox();
const sby = sbHandle0.y + 100;
await page.mouse.move(sbHandle0.x + 3, sby);
await page.mouse.down();
await page.mouse.move(sbHandle0.x + 140, sby, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
const sbBoxWide = await page.locator("#sidebar").boundingBox();
check("drag handle widens sidebar", sbBoxWide.width - sbBox0.width > 100,
  `${Math.round(sbBox0.width)}→${Math.round(sbBoxWide.width)}px`);
const gridAfterSbResize = (await page.locator("#grid").boundingBox()).width;
check("grid follows sidebar resize",
  Math.abs((gridBeforeSbResize - gridAfterSbResize) - (sbBoxWide.width - sbBox0.width)) < 3,
  `grid -${Math.round(gridBeforeSbResize - gridAfterSbResize)}px / sidebar +${Math.round(sbBoxWide.width - sbBox0.width)}px`);
check("no stuck body.dragging after sidebar resize",
  !(await page.evaluate(() => document.body.classList.contains("dragging"))));
const sbHandle1 = await page.locator("#sidebar-resize").boundingBox();
await page.mouse.move(sbHandle1.x + 3, sby);
await page.mouse.down();
await page.mouse.move(sbHandle1.x - sbBoxWide.width - 60, sby, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
check("push-in collapses sidebar", await page.locator("#sidebar").isHidden());
check("sidebar reopen tab visible after push-collapse",
  await page.locator("#sidebar-reopen").isVisible());
await page.click("#sidebar-reopen");
await page.waitForTimeout(300);
await page.dblclick("#sidebar-resize");
await page.waitForTimeout(300);
const sbBoxReset = await page.locator("#sidebar").boundingBox();
check("dblclick resets sidebar width to default", Math.abs(sbBoxReset.width - 280) < 2,
  `width=${Math.round(sbBoxReset.width)}px`);

// --- 44. 新規セッションは表示中ペインのディレクトリで開く ---
await page.evaluate(() => { window.__mockPtyCwd = "/home/user/proj"; });
const cwdSpawnBefore = await page.evaluate(() => window.__ptySpawns.length);
await page.click("#ws-new");
await page.waitForTimeout(400);
const cwdSpawns = await page.evaluate((n) => window.__ptySpawns.slice(n), cwdSpawnBefore);
check("new session inherits the focused pane's directory",
  cwdSpawns.length === 1 && cwdSpawns[0].cwd === "/home/user/proj",
  `spawns=${JSON.stringify(cwdSpawns.map((s) => s.cwd))}`);
await page.evaluate(() => { window.__mockPtyCwd = null; });

}
