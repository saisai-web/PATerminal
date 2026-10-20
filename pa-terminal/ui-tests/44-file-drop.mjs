export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// OS からのファイルドロップ → 落とし先ペインへ引用済みパスを入力
// ネイティブ側（system/drop.rs）が送る filedrop:drag / filedrop:drop を
// __emit で注入し、ハイライト・フォーカス移動・PTY への書き込みを確認する
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(400);
await page.click("#split-right");
await page.waitForTimeout(300);
// 分割直後は新しいペインにフォーカスが移るので、左へ戻してから右へ落とす
await page.locator(".pane").first().click();
await page.waitForTimeout(100);

const paneCount = await page.locator(".pane").count();
check("split produced two panes", paneCount === 2, `count=${paneCount}`);
const second = await page.locator(".pane").nth(1).boundingBox();
const cx = second.x + second.width / 2;
const cy = second.y + second.height / 2;
const secondId = await page.locator(".pane").nth(1).getAttribute("data-pane-id");
const firstFocused = await page.locator(".pane").first().evaluate((el) => el.classList.contains("is-focused"));
check("first pane is focused before the drop", firstFocused);

// --- ホバー中のハイライトはカーソル直下のペインだけに付く ---
await page.evaluate(([x, y]) => window.__emit("filedrop:drag", { kind: "enter", x, y }), [cx, cy]);
await page.waitForTimeout(50);
const enterMarks = await page.locator(".pane.is-drop-target").count();
const enterIsSecond = await page.locator(".pane").nth(1).evaluate((el) => el.classList.contains("is-drop-target"));
check("drag enter highlights only the pane under the cursor", enterMarks === 1 && enterIsSecond,
  `marks=${enterMarks} second=${enterIsSecond}`);

const firstBox = await page.locator(".pane").first().boundingBox();
await page.evaluate(([x, y]) => window.__emit("filedrop:drag", { kind: "over", x, y }),
  [firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2]);
await page.waitForTimeout(50);
const overIsFirst = await page.locator(".pane").first().evaluate((el) => el.classList.contains("is-drop-target"));
const overMarks = await page.locator(".pane.is-drop-target").count();
check("drag over moves the highlight to the new pane", overMarks === 1 && overIsFirst,
  `marks=${overMarks} first=${overIsFirst}`);

await page.evaluate(() => window.__emit("filedrop:drag", { kind: "leave", x: 0, y: 0 }));
await page.waitForTimeout(50);
const leaveMarks = await page.locator(".pane.is-drop-target").count();
check("drag leave clears the highlight", leaveMarks === 0, `marks=${leaveMarks}`);

// --- ドロップ: 落とし先ペインへ引用したパスを空白区切り + 末尾空白で書く ---
await page.evaluate(([x, y]) => window.__emit("filedrop:drag", { kind: "enter", x, y }), [cx, cy]);
const before = await page.evaluate(() => window.__ptyWrites.length);
await page.evaluate(([x, y]) => window.__emit("filedrop:drop",
  { paths: ["/home/user/a b.txt", "/tmp/it's"], x, y }), [cx, cy]);
await page.waitForTimeout(200);
const writes = await page.evaluate((n) => window.__ptyWrites.slice(n), before);
const sent = writes.map((w) => w.data).join("");
check("dropped paths are quoted for the shell with a trailing space",
  sent === "'/home/user/a b.txt' '/tmp/it'\\''s' ", `sent=${JSON.stringify(sent)}`);
check("the write goes to the pane under the cursor",
  writes.length > 0 && writes.every((w) => w.id === secondId),
  `ids=${JSON.stringify(writes.map((w) => w.id))} second=${secondId}`);
const dropMarks = await page.locator(".pane.is-drop-target").count();
check("drop clears the highlight", dropMarks === 0, `marks=${dropMarks}`);
const secondFocused = await page.locator(".pane").nth(1).evaluate((el) => el.classList.contains("is-focused"));
check("drop focuses the target pane", secondFocused);

// --- ペイン外（サイドバー）へのドロップと空のドロップは何も書かない ---
const sidebar = await page.locator("#sidebar").boundingBox();
const before2 = await page.evaluate(() => window.__ptyWrites.length);
await page.evaluate(([x, y]) => window.__emit("filedrop:drop", { paths: ["/tmp/x"], x, y }),
  [sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2]);
await page.evaluate(([x, y]) => window.__emit("filedrop:drop", { paths: [], x, y }), [cx, cy]);
await page.waitForTimeout(200);
const after2 = await page.evaluate(() => window.__ptyWrites.length);
check("drops outside a pane or without paths write nothing", after2 === before2,
  `before=${before2} after=${after2}`);
await page.close();

// --- Windows ホスト（PowerShell）では単一引用符で囲む ---
const win = await browser.newPage({ viewport: { width: 1280, height: 820 } });
win.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await win.addInitScript(() => { window.__mockHostOs = "windows"; });
await win.goto(BASE_URL);
await win.waitForSelector(".pane", { timeout: 10000 });
await win.waitForTimeout(400);
const box = await win.locator(".pane").first().boundingBox();
const wBefore = await win.evaluate(() => window.__ptyWrites.length);
await win.evaluate(([x, y]) => window.__emit("filedrop:drop", { paths: ["C:\\tmp\\$env\\a b.png"], x, y }),
  [box.x + box.width / 2, box.y + box.height / 2]);
await win.waitForTimeout(200);
const wSent = await win.evaluate((n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""), wBefore);
check("Windows drop quotes the path for PowerShell",
  wSent === "'C:\\tmp\\$env\\a b.png' ", `sent=${JSON.stringify(wSent)}`);
await win.close();

// ============================================================
// フォルダーブラウザーの上へのドロップ → ペインには入力せず、フォルダーへコピー（fs_import）
// ============================================================
const fb = await browser.newPage({ viewport: { width: 1280, height: 820 } });
fb.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await fb.goto(BASE_URL);
await fb.waitForSelector(".pane-pathbar");
await fb.locator(".pane-pathbar-path").click();
await fb.waitForSelector(".pathbar-row", { hasText: "proj" });
const center = (sel) => fb.locator(sel).first().boundingBox().then((b) => [b.x + b.width / 2, b.y + b.height / 2]);
const drag = (kind, [x, y]) => fb.evaluate(([kind, x, y]) => window.__emit("filedrop:drag", { kind, x, y }), [kind, x, y]);
const drop = (paths, [x, y]) => fb.evaluate(([paths, x, y]) => window.__emit("filedrop:drop", { paths, x, y }), [paths, x, y]);

// ドラッグの開始で窓が blur しても閉じない（Finder をクリックしてからドラッグするため）
await fb.evaluate(() => window.dispatchEvent(new Event("blur")));
await fb.waitForTimeout(50);
check("folder browser: stays open when the window loses focus", (await fb.locator(".pathbar-pop").count()) === 1);

// 一覧の空き（ファイル行）は表示中のフォルダー、フォルダー行はそのフォルダーを落とし先にする
const fileRow = await center(".pathbar-row:not(.is-dir)");
await drag("enter", fileRow);
await fb.waitForTimeout(50);
const mainMark = await fb.evaluate(() => ({
  main: document.querySelector(".pathbar-main").classList.contains("is-drop-target"),
  hint: document.querySelector(".pathbar-main").dataset.dropHint,
  panes: document.querySelectorAll(".pane.is-drop-target").length,
}));
check("folder browser: dragging over the list targets the shown folder, not the pane",
  mainMark.main && mainMark.hint?.includes("user") && mainMark.panes === 0, JSON.stringify(mainMark));
const projRow = await center(".pathbar-row.is-dir >> text=proj");
await drag("over", projRow);
await fb.waitForTimeout(50);
const rowMark = await fb.evaluate(() => ({
  row: [...document.querySelectorAll(".pathbar-row.is-drop-target")].map((el) => el.textContent),
  main: document.querySelector(".pathbar-main").classList.contains("is-drop-target"),
}));
check("folder browser: dragging over a folder row targets that folder",
  rowMark.row.length === 1 && rowMark.row[0].includes("proj") && !rowMark.main, JSON.stringify(rowMark));
await drag("leave", [0, 0]);
await fb.waitForTimeout(50);
check("folder browser: drag leave clears the marks",
  (await fb.locator(".pathbar-pop .is-drop-target").count()) === 0);

// 表示中のフォルダーへコピーし、一覧を読み直して最初の項目を選ぶ
const fbWrites = await fb.evaluate(() => window.__ptyWrites.length);
await fb.evaluate(() => { window.__mockImportDirs = ["/src/assets"]; });
await drop(["/src/note.txt", "/src/assets"], fileRow);
await fb.waitForFunction(() => document.querySelector(".pathbar-notice:not([hidden])")?.textContent.includes("2"));
const imported = await fb.evaluate((n) => ({
  imports: window.__fsImports.slice(-1)[0],
  rows: [...document.querySelectorAll(".pathbar-row")].map((el) => el.textContent),
  selected: document.querySelector('.pathbar-row[aria-selected="true"]')?.textContent,
  writes: window.__ptyWrites.length - n,
  open: !!document.querySelector(".pathbar-pop"),
}), fbWrites);
check("folder browser: a drop copies into the shown folder and refreshes the list",
  imported.imports?.destDir === "/home/user" &&
  JSON.stringify(imported.imports.sources) === JSON.stringify(["/src/note.txt", "/src/assets"]) &&
  imported.rows.some((r) => r.includes("note.txt")) && imported.rows.some((r) => r.includes("assets")) &&
  imported.selected?.includes("note.txt") && imported.writes === 0 && imported.open, JSON.stringify(imported));

// フォルダー行へ落とすとそのフォルダーへ
await drop(["/src/other.txt"], await center(".pathbar-row.is-dir >> text=proj"));
await fb.waitForFunction(() => window.__fsImports.slice(-1)[0]?.sources[0] === "/src/other.txt");
check("folder browser: a drop on a folder row copies into that folder",
  (await fb.evaluate(() => window.__fsImports.slice(-1)[0].destDir)) === "/home/user/proj");

// 同名があれば何もコピーせず、理由を出す
const importsBefore = await fb.evaluate(() => window.__fsImports.length);
await drop(["/elsewhere/readme.md"], await center(".pathbar-row:not(.is-dir) >> text=readme.md"));
await fb.waitForFunction(() => document.querySelector(".pathbar-notice.is-error:not([hidden])"));
check("folder browser: a name collision copies nothing and shows the error",
  (await fb.evaluate(() => window.__fsImports.length)) === importsBefore);

// 閉じた後はペインへのドロップが従来どおりパス入力になる
await fb.keyboard.press("Escape");
await fb.waitForFunction(() => !document.querySelector(".pathbar-pop"));
const pbox = await fb.locator(".pane .xterm").first().boundingBox();
const outsideWrites = await fb.evaluate(() => window.__ptyWrites.length);
await drop(["/tmp/x"], [pbox.x + 20, pbox.y + 20]);
await fb.waitForTimeout(200);
const outsideSent = await fb.evaluate((n) => window.__ptyWrites.slice(n).map((w) => w.data).join(""), outsideWrites);
check("folder browser: after closing, drops type the path into the pane again",
  outsideSent === "'/tmp/x' ", `sent=${JSON.stringify(outsideSent)}`);
await fb.close();
}
