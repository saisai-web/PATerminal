export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// 打鍵なしの出力を実行中と見なすまでの連続出力時間（製品では3秒）。テストでは短縮するが、
// 「出力開始 → 状態を読む → idle を送る」の往復（CI の遅いランナーで 100ms を超える）より
// 十分長くないと、短い再描画 burst のつもりが実作業と判定されて flaky になる
const OUTPUT_BUSY_MS = 250;

// ============================================================
// 稼働インジケータ + 通知（pty:act / pty:bell → ドット・デスクトップ通知）
// ============================================================

const pageAct = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageAct.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageAct.addInitScript((outputBusyMs) => {
  window.__activityTuning = { outputBusyMs };
  window.__mockSessionLoad = JSON.stringify({
    version: 3,
    activeId: "wa",
    settings: { language: "ja" },
    workspaces: [
      { id: "wa", name: "Alpha", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "a" } },
      { id: "wb", name: "Beta", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "b", resumeShell: "codex" } },
      { id: "wc", name: "Gamma", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "c", run: "claude" } },
    ],
  });
}, OUTPUT_BUSY_MS);
await pageAct.goto(BASE_URL);
await pageAct.waitForSelector(".pane", { timeout: 10000 });
await pageAct.waitForTimeout(400);
{
  // appFocused を確定させる（headless では hasFocus が不定なため明示的に focus を配送）
  await pageAct.evaluate(() => window.dispatchEvent(new Event("focus")));
  // ペイン id は復元順に spawn される（wa → wb → wc）
  const [idA, idB, idC] = await pageAct.evaluate(() => window.__ptySpawns.map((s) => s.id));
  const emit = (event, payload) =>
    pageAct.evaluate(([ev, pl]) => window.__emit(ev, pl), [event, payload]);
  const notifCount = () => pageAct.evaluate(() => window.__notifications.length);
  // 打鍵なしの出力が outputBusyMs を超えて続いた = 実作業として実行中になる
  const startBusy = async (id) => {
    await emit("pty:act", { id, busy: true, busyMs: 0 });
    await pageAct.waitForTimeout(OUTPUT_BUSY_MS + 150);
  };
  const hasClass = (wsId, cls) =>
    pageAct.evaluate(
      ([id, c]) => document.querySelector(`.ws-item[data-ws-id="${id}"]`)?.classList.contains(c) ?? false,
      [wsId, cls],
    );
  const statusText = (wsId) =>
    pageAct.locator(`.ws-item[data-ws-id="${wsId}"] .ws-status`).textContent();

  // イベントが来る前も状態ラベルは常設される
  check("initial status is always visible", (await statusText("wa")) === "完了");

  // 直接復元した codex は、ペインを開いたときの初期出力だけで実行中にならない
  await emit("pty:act", { id: idB, busy: true, busyMs: 0 });
  check("opening a direct codex pane does not show running",
    (await statusText("wb")) === "完了" && !(await hasClass("wb", "is-busy")));
  await emit("pty:act", { id: idB, busy: false, busyMs: 100 });

  // 自動で claude コマンドを入力して起動する場合も、質問を送るまでは作業中にしない
  await pageAct.waitForFunction((id) => window.__ptyWrites.some((write) => write.id === id), idC);
  check("opening an auto-start claude pane does not show running",
    (await statusText("wc")) === "完了" && !(await hasClass("wc", "is-busy")));

  // TUI がフォーカス通知を有効にしていても、セッションを開いただけでは
  // ESC [ I / ESC [ O をターミナル操作と誤認して「実行中」にしない
  await pageAct.evaluate(() => window.__ptyPushAll("\x1b[?1004h"));
  await pageAct.waitForTimeout(50);
  await pageAct.locator('.ws-item[data-ws-id="wb"] .ws-head').click();
  check("switching sessions alone does not show running",
    (await statusText("wb")) === "完了" && !(await hasClass("wb", "is-busy")));
  await pageAct.locator('.ws-item[data-ws-id="wa"] .ws-head').click();

  // TUI の問い合わせ（カーソル位置 / DA / 色）に xterm が自動で返す応答は、onData を
  // 通っても操作ではない。claude / codex を開いただけでは実行中にしない
  await pageAct.evaluate(() => window.__ptyPushAll("\x1b[6n\x1b[c\x1b]11;?\x07"));
  await pageAct.waitForTimeout(80);
  check("terminal query replies do not show running",
    (await statusText("wa")) === "完了" && !(await hasClass("wa", "is-busy")) &&
      (await statusText("wb")) === "完了" && !(await hasClass("wb", "is-busy")));

  // 初回の起動出力と BEL は完了のまま。最初の idle 後から通常判定を開始する
  await emit("pty:act", { id: idA, busy: true, busyMs: 0 });
  await emit("pty:bell", { id: idA });
  await emit("pty:act", { id: idA, busy: false, busyMs: 100 });
  check("startup output and bell keep initial done status",
    (await statusText("wa")) === "完了" && !(await hasClass("wa", "is-attn")) && (await notifCount()) === 0);

  // 実際のターミナル入力なら即座に実行中となり、PTY の静止で完了へ戻る
  await pageAct.locator('.workspace-layer:not([hidden]) .pane .pane-body').first().click();
  await pageAct.keyboard.press("x");
  check("terminal input starts running status",
    (await statusText("wa")) === "実行中" && await hasClass("wa", "is-busy"));
  await emit("pty:act", { id: idA, busy: false, busyMs: 100 });

  // 後段でバックグラウンド稼働を検証する wb も、初期化を終えて一度操作済みにしておく
  await emit("pty:act", { id: idB, busy: true, busyMs: 0 });
  await emit("pty:act", { id: idB, busy: false, busyMs: 100 });
  await pageAct.locator('.ws-item[data-ws-id="wb"] .ws-head').click();
  await pageAct.locator('.workspace-layer:not([hidden]) .pane .pane-body').first().click();
  await pageAct.keyboard.press("x");
  await emit("pty:act", { id: idB, busy: false, busyMs: 100 });
  await pageAct.locator('.ws-item[data-ws-id="wa"] .ws-head').click();

  // 出力だけの busy 開始は、短い再描画と区別するため outputBusyMs 続くまで表示を変えない
  await emit("pty:act", { id: idA, busy: true, busyMs: 0 });
  check("output-only busy start is provisional",
    !(await hasClass("wa", "is-busy")) && (await statusText("wa")) === "完了");
  // 出力が続く → アクティブセッションでも緑ドットは付く
  await pageAct.waitForTimeout(OUTPUT_BUSY_MS + 150);
  check("busy start shows is-busy dot", await hasClass("wa", "is-busy"));
  check("busy start shows running text", (await statusText("wa")) === "実行中");

  // アクティブ + フォーカス中の完了 → ラベルは残り、通知とオレンジだけ出ない（ゲート）
  await emit("pty:act", { id: idA, busy: false, busyMs: 6000 });
  await pageAct.waitForTimeout(150);
  check("busy end clears is-busy dot", !(await hasClass("wa", "is-busy")));
  check("focused completion keeps done text", (await statusText("wa")) === "完了");
  check("active+focused completion is gated (no attn, no notification)",
    !(await hasClass("wa", "is-attn")) && (await notifCount()) === 0,
    `notifs=${await notifCount()}`);

  // 非アクティブセッションの完了 → オレンジドット + 通知
  await startBusy(idB);
  check("hidden session busy dot", await hasClass("wb", "is-busy"));
  await emit("pty:act", { id: idB, busy: false, busyMs: 6000 });
  await pageAct.waitForTimeout(150);
  check("inactive completion sets attention + notifies",
    (await hasClass("wb", "is-attn")) && (await notifCount()) === 1,
    `notifs=${await notifCount()}`);
  check("inactive completion shows done text", (await statusText("wb")) === "完了");

  // クールダウン: 直後の再完了は通知を間引く
  await startBusy(idB);
  await emit("pty:act", { id: idB, busy: false, busyMs: 6000 });
  await pageAct.waitForTimeout(150);
  check("notification cooldown suppresses repeat", (await notifCount()) === 1,
    `notifs=${await notifCount()}`);

  // セッションをアクティブ化すると注意ドットが消える
  await pageAct.locator('.ws-item[data-ws-id="wb"] .ws-head').click();
  await pageAct.waitForTimeout(100);
  check("activating session clears attention", !(await hasClass("wb", "is-attn")));
  check("activating session keeps status text", (await statusText("wb")) === "完了");

  // 再描画の burst（セッション切替のフォーカス通知・リサイズ・起動時の問い合わせで
  // TUI が短く出力しただけ）。操作済みで非アクティブなセッションでも、実行中にも
  // 完了・未読ドット・通知にもならない（開いただけで通知が量産されていたバグ）
  await pageAct.locator('.ws-item[data-ws-id="wa"] .ws-head').click();
  await emit("pty:act", { id: idB, busy: true, busyMs: 0 });
  check("redraw burst does not show running",
    (await statusText("wb")) === "完了" && !(await hasClass("wb", "is-busy")));
  await emit("pty:act", { id: idB, busy: false, busyMs: 300 });
  await pageAct.waitForTimeout(150);
  check("redraw burst on inactive session adds no attention or notification",
    !(await hasClass("wb", "is-attn")) && (await notifCount()) === 1 &&
      (await statusText("wb")) === "完了",
    `notifs=${await notifCount()}`);
  // 静止直後の再描画 burst も同様（idle が来るたびに完了扱いにしない）
  await emit("pty:act", { id: idB, busy: true, busyMs: 0 });
  await emit("pty:act", { id: idB, busy: false, busyMs: 100 });
  await pageAct.waitForTimeout(150);
  check("repeated idle without work stays quiet",
    !(await hasClass("wb", "is-attn")) && (await notifCount()) === 1,
    `notifs=${await notifCount()}`);
  await pageAct.locator('.ws-item[data-ws-id="wb"] .ws-head').click();

  // ベル（非アクティブ = wa）→ 完了扱いのオレンジ + 通知
  await emit("pty:bell", { id: idA });
  await pageAct.waitForTimeout(150);
  check("bell on inactive session notifies",
    (await hasClass("wa", "is-attn")) && (await notifCount()) === 2,
    `notifs=${await notifCount()}`);
  check("bell defaults to done text", (await statusText("wa")) === "完了");

  // ベル（アクティブ + フォーカス中 = wb）→ ラベルは完了、通知と未読ドットは出ない
  await emit("pty:bell", { id: idB });
  await pageAct.waitForTimeout(150);
  check("bell on active+focused session is gated",
    !(await hasClass("wb", "is-attn")) && (await notifCount()) === 2,
    `notifs=${await notifCount()}`);
  check("focused bell keeps done text", (await statusText("wb")) === "完了");

  // renderSidebar の全再構築でもドットが再導出される（検索欄で再描画を起こす）
  await startBusy(idA);
  await pageAct.locator("#ws-search").fill("a");
  await pageAct.locator("#ws-search").fill("");
  await pageAct.waitForTimeout(100);
  check("dots survive full sidebar rebuild",
    (await hasClass("wa", "is-busy")) && (await hasClass("wa", "is-attn")));
  check("running text survives full sidebar rebuild", (await statusText("wa")) === "実行中");
  await emit("pty:act", { id: idA, busy: false, busyMs: 100 });

  // アプリが非フォーカスならアクティブセッションでも通知する
  // （wb は上の完了通知から 5 秒のクールダウン内なので、切れるまで待つ）
  await pageAct.waitForTimeout(5100);
  await pageAct.evaluate(() => window.dispatchEvent(new Event("blur")));
  await emit("pty:bell", { id: idB });
  await pageAct.waitForTimeout(150);
  check("bell notifies when app unfocused even on active session",
    (await hasClass("wb", "is-attn")) && (await notifCount()) === 3,
    `notifs=${await notifCount()}`);
  // フォーカス復帰でアクティブセッションの注意は既読になる
  await pageAct.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pageAct.waitForTimeout(100);
  check("refocus clears active session attention", !(await hasClass("wb", "is-attn")));
  check("refocus keeps active session status", (await statusText("wb")) === "完了");

  // 入力待ち（Rust が承認ダイアログ等を検知して waiting:true を付ける）。
  // 出力中のベルは静止まで保留され、完了ではなく入力待ちとして1通だけ通知する
  const lastNotifTitle = () =>
    pageAct.evaluate(() => window.__notifications.at(-1)?.title ?? "");
  await emit("pty:act", { id: idA, busy: true, busyMs: 0 });
  await emit("pty:bell", { id: idA });
  await emit("pty:act", { id: idA, busy: false, busyMs: 200, waiting: true });
  await pageAct.waitForTimeout(150);
  check("waiting idle shows waiting text", (await statusText("wa")) === "入力待ち");
  check("waiting idle shows is-wait dot",
    (await hasClass("wa", "is-wait")) && !(await hasClass("wa", "is-busy")));
  check("short waiting still notifies once as waiting",
    (await notifCount()) === 4 && (await lastNotifTitle()) === "入力待ち",
    `notifs=${await notifCount()} title=${await lastNotifTitle()}`);
  check("waiting sets attention on inactive session", await hasClass("wa", "is-attn"));

  // 再描画でも入力待ちは再導出される
  await pageAct.locator("#ws-search").fill("a");
  await pageAct.locator("#ws-search").fill("");
  await pageAct.waitForTimeout(100);
  check("waiting survives full sidebar rebuild",
    (await hasClass("wa", "is-wait")) && (await statusText("wa")) === "入力待ち");

  // 応答して出力が再開すれば入力待ちは解除される
  await startBusy(idA);
  check("output resume clears waiting",
    !(await hasClass("wa", "is-wait")) && (await statusText("wa")) === "実行中");
  await emit("pty:act", { id: idA, busy: false, busyMs: 100, waiting: false });
  await pageAct.waitForTimeout(100);
  check("idle without waiting returns to done", (await statusText("wa")) === "完了");

  // 見ているセッションの入力待ちはラベルだけ（通知も未読ドットも出さない）
  await startBusy(idB);
  await emit("pty:act", { id: idB, busy: false, busyMs: 200, waiting: true });
  await pageAct.waitForTimeout(150);
  check("active+focused waiting shows label without notification",
    (await statusText("wb")) === "入力待ち" &&
      (await hasClass("wb", "is-wait")) &&
      !(await hasClass("wb", "is-attn")) &&
      (await notifCount()) === 4,
    `notifs=${await notifCount()}`);
  await emit("pty:act", { id: idB, busy: true, busyMs: 0 });
  await emit("pty:act", { id: idB, busy: false, busyMs: 100, waiting: false });

  // 設定で通知 OFF → 保存され、以後は通知されない（ドットは出る）
  await pageAct.locator("#settings-open").click();
  await pageAct.click('#settings-nav .settings-nav-item[data-section="notifications"]');
  check("settings has notifications toggle (checked)",
    await pageAct.locator("#settings-notif").isChecked());
  await pageAct.locator("#settings-notif").uncheck();
  await pageAct.locator("#settings-close").click();
  await pageAct.waitForTimeout(1600); // scheduleSave のデバウンス + アイドル保存待ち
  const savedNotif = await pageAct.evaluate(
    () => JSON.parse(window.__savedSession).settings.notifications,
  );
  check("notifications=false persisted in settings", savedNotif === false, `saved=${savedNotif}`);
  await emit("pty:bell", { id: idA });
  await pageAct.waitForTimeout(150);
  check("toggle off suppresses notification but keeps attention dot",
    (await hasClass("wa", "is-attn")) && (await notifCount()) === 4,
    `notifs=${await notifCount()}`);
}
await pageAct.close();

}
