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
}
