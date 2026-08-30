export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// ターミナルのコピー & 貼り付け（Windows: Ctrl+V / Ctrl+C）
//
// xterm は Ctrl+V / Ctrl+C を「^V / ^C を送る打鍵」として処理し、最後に必ず
// preventDefault するので、放っておくと WebView 既定の貼り付けが動かない。
// このスイートはその横取りを外せているかだけを見る（macOS の Cmd 系は
// もともと xterm が触らないため対象外）。
// ============================================================

const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => { window.__mockHostOs = "windows"; });
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.locator(".pane .pane-body").first().click();
await page.waitForTimeout(400);

// --- Ctrl+V はクリップボードの中身を PTY へ流す（^V ではない） ---
await page.evaluate(() => navigator.clipboard.writeText("echo pasted"));
const beforePaste = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("Control+v");
await page.waitForTimeout(400);
let pasted = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), beforePaste);
// headless Chromium は OS のクリップボードを使った keyboard.press では native の
// paste イベントを発火しないことがある。実機相当のイベント経路が無い場合だけ、
// 同じ ClipboardEvent を明示的に流して xterm の paste ハンドラを検証する。
if (!pasted.includes("echo pasted")) {
  await page.evaluate(() => {
    const textarea = document.querySelector(".xterm-helper-textarea");
    if (!textarea) return;
    const data = new DataTransfer();
    data.setData("text/plain", "echo pasted");
    textarea.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
  });
  await page.waitForTimeout(400);
  pasted = await page.evaluate(
    (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), beforePaste);
}
check("Ctrl+V pastes the clipboard instead of sending ^V",
  pasted.includes("echo pasted") && !pasted.includes("\x16"), `sent=${JSON.stringify(pasted)}`);
check("paste does not send a newline on its own",
  !pasted.includes("\r") && !pasted.includes("\n"), `sent=${JSON.stringify(pasted)}`);
// 既定の挿入まで通すと同じ文字列が隠し textarea にも残る（次の入力に混ざる）
const leftover = await page.evaluate(
  () => document.querySelector(".xterm-helper-textarea")?.value ?? "");
check("paste leaves the hidden textarea empty", leftover === "", `value=${JSON.stringify(leftover)}`);

// --- 選択があるときの Ctrl+C はコピー。選択が無ければ従来どおり SIGINT ---
await page.evaluate(async () => {
  const { panes } = await import("/src/workspace/state.ts");
  const pane = [...panes.values()][0];
  pane.term.write("copy me\r\n");
});
await page.waitForTimeout(300);
await page.evaluate(async () => {
  const { panes } = await import("/src/workspace/state.ts");
  [...panes.values()][0].term.selectAll();
});
const beforeCopy = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("Control+c");
await page.waitForTimeout(400);
const copied = await page.evaluate(() => navigator.clipboard.readText());
const afterCopy = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), beforeCopy);
check("Ctrl+C with a selection copies it instead of sending SIGINT",
  copied.includes("copy me") && !afterCopy.includes("\x03"),
  `clipboard=${JSON.stringify(copied.slice(0, 40))} sent=${JSON.stringify(afterCopy)}`);

// コピーで選択を消すので、続けて押した Ctrl+C はちゃんと中断になる
const beforeSigint = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.press("Control+c");
await page.waitForTimeout(300);
const sigint = await page.evaluate(
  (n) => window.__ptyWrites.slice(n).map((x) => x.data).join(""), beforeSigint);
check("Ctrl+C without a selection still sends SIGINT",
  sigint.includes("\x03"), `sent=${JSON.stringify(sigint)}`);

await page.close();
}
