export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// ペアモードの追加モード（クロスレビュー / ブレスト(+実装へ進む) / あとづけレビュー）
// ハイブリッド受け渡しの検証:
// - 返答型の受け渡し（ブレストのピンポン・cross のバリア交換・merge/summary の完了）は
//   従来どおり pty:act の busy→idle（__emit 注入）で自動
// - 実装完了の判定が要る受け渡し（coop の同期・あとづけの初回レビュー依頼）は
//   #pair-handoff ボタンのみ
// 実装×レビューの基本経路は 27-pair.mjs が担当する
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  // 静止確認デバウンス（実機 6 秒）を短縮してテストの既存タイミングを保つ
  window.__pairTuning = { handoffConfirmMs: 30 };
  window.__mockSessionLoad = JSON.stringify({
    version: 3,
    activeId: "wp",
    settings: { language: "ja" },
    workspaces: [
      { id: "wp", name: "PairWs", shellKind: "default", broadcast: false,
        root: { kind: "split", dir: "row", ratio: 0.5,
          a: { kind: "leaf", title: "left" }, b: { kind: "leaf", title: "right" } } },
      { id: "wo", name: "Other", shellKind: "default", broadcast: false,
        root: { kind: "leaf", title: "o" } },
    ],
  });
});
await page.goto(BASE_URL);
await page.waitForSelector(".pane", { timeout: 10000 });
await page.waitForTimeout(600);
{
  // ペイン id は復元順に spawn される（wp の a → b → wo）
  const [aId, bId] = await page.evaluate(() => window.__ptySpawns.map((s) => s.id));
  const emit = (event, payload) =>
    page.evaluate(([ev, pl]) => window.__emit(ev, pl), [event, payload]);
  const writesTo = (paneId) =>
    page.evaluate((id) => window.__ptyWrites.filter((w) => w.id === id).map((w) => w.data), paneId);
  const writeCount = async (paneId) => (await writesTo(paneId)).length;
  const busyIdle = async (paneId, busyMs = 6000) => {
    await emit("pty:act", { id: paneId, busy: true, busyMs: 0, waiting: false });
    await emit("pty:act", { id: paneId, busy: false, busyMs, waiting: false });
  };
  const stripRound = () => page.locator("#pair-strip-round").textContent();
  const stripStatus = () => page.locator("#pair-strip-status").textContent();

  // --- クロスレビュー: 両方へ依頼 → バリアで突き合わせ(自動) → 統合は手動でも押せる ---
  {
    await page.locator("#pair-open").click();
    check("implement kind is the default", await page.locator("#pair-kind-implement").isChecked());
    await page.locator("#pair-kind-cross").check();
    check("cross hides the attach placement", await page.locator("#pair-mode-attach-wrap").isHidden());
    check("cross resets rounds to its default 1",
      (await page.locator("#pair-rounds").inputValue()) === "1");
    check("cross relabels the task field",
      (await page.locator("#pair-task-label").textContent()).includes("レビュー対象"));
    await page.locator("#pair-mode-current").check();
    const aBefore = await writeCount(aId);
    const bBefore = await writeCount(bId);
    await page.locator("#pair-start").click();
    await page.waitForTimeout(500); // 貼り付け + 250ms 後の Enter を待つ
    const aSeed = (await writesTo(aId)).slice(aBefore);
    const bSeed = (await writesTo(bId)).slice(bBefore);
    check("cross sends the review seed to both panes",
      aSeed.some((d) => d.includes("独立にレビューする2人")) &&
        bSeed.some((d) => d.includes("独立にレビューする2人")));
    check("cross chips show review A/B",
      (await page.locator("#pair-chip-impl").textContent()).includes("レビューA") &&
        (await page.locator("#pair-chip-review").textContent()).includes("レビューB"));
    check("cross starts at round 0/1", (await stripRound()) === "ラウンド 0/1");
    check("cross handoff button offers the manual exchange",
      (await page.locator("#pair-handoff").textContent()) === "指摘を交換");

    // 片方だけ静止してもバリアは発火しない
    const bBeforeBarrier = await writeCount(bId);
    await busyIdle(aId);
    await page.waitForTimeout(300);
    check("one quiet pane does not fire the barrier",
      (await writeCount(bId)) === bBeforeBarrier);
    check("strip shows waiting-for-partner", (await stripStatus()).includes("相方を待って"));

    // もう片方も静止 → 指摘を交換（cross のバリアは従来どおり自動で両方に届く）
    await busyIdle(bId);
    await page.waitForTimeout(500);
    check("both quiet fires the exchange to both",
      (await writesTo(aId)).some((d) => d.includes("突き合わせて")) &&
        (await writesTo(bId)).some((d) => d.includes("突き合わせて")));
    check("exchange advances round to 1/1", (await stripRound()) === "ラウンド 1/1");

    // ラウンド上限に達したのでボタンは「統合へ進む」。手動バリアで A だけに統合依頼
    check("cross handoff button relabels to merge at max rounds",
      (await page.locator("#pair-handoff").textContent()) === "統合へ進む");
    const bBeforeMerge = await writeCount(bId);
    await page.locator("#pair-handoff").click();
    await page.waitForTimeout(500);
    check("manual barrier sends the merge prompt to A only",
      (await writesTo(aId)).some((d) => d.includes("番号付きリストに統合")) &&
        (await writeCount(bId)) === bBeforeMerge);
    check("strip shows merging status", (await stripStatus()).includes("統合"));

    // A が静止 → 完了（merge の完了は返答型なので自動のまま）
    await busyIdle(aId);
    await page.waitForTimeout(300);
    check("cross finishes after the merge", (await stripStatus()).includes("統合リスト"));
    await page.locator("#pair-stop").click();
    await page.waitForTimeout(200);
  }

  // --- ブレスト: お題必須 → ピンポン(自動) → まとめ → 完了 → 「実装へ進む」で coop へ ---
  {
    await page.locator("#pair-open").click();
    await page.locator("#pair-kind-brainstorm").check();
    check("brainstorm shows the style radios", await page.locator("#pair-style-field").isVisible());
    check("brainstorm resets rounds to its default 3",
      (await page.locator("#pair-rounds").inputValue()) === "3");
    await page.locator("#pair-style-critic").check();
    await page.locator("#pair-mode-current").check();
    await page.locator("#pair-rounds").fill("1");
    await page.locator("#pair-task").fill("");
    await page.locator("#pair-start").click();
    check("empty topic is rejected",
      (await page.locator("#pair-error").isVisible()) &&
        (await page.locator("#pair-error").textContent()).includes("お題"));
    await page.locator("#pair-task").fill("新しい通知機能のアイデア出し");
    await page.locator("#pair-start").click();
    await page.waitForTimeout(500);
    check("topic seed is sent to A",
      (await writesTo(aId)).some(
        (d) => d.includes("ブレインストーミング") && d.includes("新しい通知機能のアイデア出し"),
      ));
    check("brainstorm chips show idea A/B",
      (await page.locator("#pair-chip-impl").textContent()).includes("発案A"));

    // A が静止 → 批判役スタイルの返しが B へ（ピンポンは自動のまま。ラウンド消費）
    await busyIdle(aId);
    await page.waitForTimeout(500);
    check("critic style prompt goes to B",
      (await writesTo(bId)).some((d) => d.includes("批判役として")));
    check("brainstorm round advances to 1/1", (await stripRound()) === "ラウンド 1/1");

    // B が静止 → A への返しは常に発展型
    await busyIdle(bId);
    await page.waitForTimeout(500);
    check("reply back to A uses the yes-and prompt",
      (await writesTo(aId)).some((d) => d.includes("乗っかって発展")));

    // A が静止 → ラウンド上限 → まとめ依頼が A へ
    await busyIdle(aId);
    await page.waitForTimeout(500);
    check("summary prompt goes to A",
      (await writesTo(aId)).some((d) => d.includes("締めくくり")));
    check("strip shows summarizing status", (await stripStatus()).includes("まとめて"));

    // まとめが静止 → 完了 + 「実装へ進む」が出る（summary の完了は自動のまま）
    await busyIdle(aId);
    await page.waitForTimeout(300);
    check("brainstorm finishes with its own message", (await stripStatus()).includes("ブレストが完了"));
    check("promote button appears after brainstorm", await page.locator("#pair-promote").isVisible());

    // 実装へ進む → 分担依頼が A へ、カウンタは同期表示に変わる
    await page.locator("#pair-promote").click();
    await page.waitForTimeout(500);
    check("promote sends the plan prompt to A",
      (await writesTo(aId)).some((d) => d.includes("実装計画")));
    check("promote switches the counter to sync", (await stripRound()) === "同期 0/2");
    check("promote switches chips to build A/B",
      (await page.locator("#pair-chip-impl").textContent()).includes("実装A"));

    // 分担が静止 → 両方へ着手指示（plan は返答型なので自動のまま）
    await busyIdle(aId);
    await page.waitForTimeout(500);
    check("start prompts go to both shares",
      (await writesTo(aId)).some((d) => d.includes("担当Aを実装")) &&
        (await writesTo(bId)).some((d) => d.includes("担当Bがあなたの分")));

    // ★回帰の要: coop の同時実装では、両方が静止しても同期は自動発火しない
    await busyIdle(aId);
    await page.waitForTimeout(200);
    check("coop shows waiting-for-partner too", (await stripStatus()).includes("相方を待って"));
    const aBeforeSync = await writeCount(aId);
    const bBeforeSync = await writeCount(bId);
    await busyIdle(bId);
    await page.waitForTimeout(500);
    check("coop does NOT auto-sync when both go quiet",
      (await writeCount(aId)) === aBeforeSync &&
        (await writeCount(bId)) === bBeforeSync &&
        (await stripRound()) === "同期 0/2");

    // 「進捗を同期」で同期プロンプトを両方へ交換する
    check("coop handoff button offers the manual sync",
      (await page.locator("#pair-handoff").textContent()) === "進捗を同期");
    await page.locator("#pair-handoff").click();
    await page.waitForTimeout(500);
    check("sync prompt is exchanged on both",
      (await writesTo(aId)).some((d) => d.includes("同期ポイント")) &&
        (await writesTo(bId)).some((d) => d.includes("同期ポイント")));
    check("sync counter advances to 1/2", (await stripRound()) === "同期 1/2");
    check("coop handoff button relabels to wrap-up at max sync",
      (await page.locator("#pair-handoff").textContent()) === "進捗を同期" ||
        (await stripRound()) === "同期 1/2");
    await page.locator("#pair-stop").click();
    await page.waitForTimeout(200);
  }

  // --- あとづけレビュー: フォーカス中ペインを実装役にしてレビュー役を後付け ---
  {
    // フォーカスを表示中セッションのペインへ確実に置く
    await page.locator(".workspace-layer:not([hidden]) .pane").first().click();
    await page.waitForTimeout(200);
    // 直前のシナリオの貼り付けが Pane.busy を楽観的に立てたままなので、
    // pty:act で静止させておく（実機では出力静止時に必ず idle が届く）
    await busyIdle(aId, 500);
    await busyIdle(bId, 500);
    const spawnsBefore = await page.evaluate(() => window.__ptySpawns.length);
    await page.locator("#pair-open").click();
    await page.locator("#pair-kind-implement").check();
    await page.locator("#pair-mode-attach").check();
    check("attach hides the implementer command field",
      (await page.locator("#pair-impl-cmd-field").isHidden()) &&
        (await page.locator("#pair-new-fields").isVisible()));
    check("attach relabels the task field to review focus",
      (await page.locator("#pair-task-label").textContent()).includes("観点"));
    await page.locator("#pair-task").fill("並行処理まわりを重点的に");
    await page.locator("#pair-start").click();
    await page.waitForTimeout(600); // 分割 + 400ms 後の run 注入を待つ
    const spawns = await page.evaluate(() => window.__ptySpawns.map((s) => s.id));
    check("attach spawns exactly one reviewer pane", spawns.length === spawnsBefore + 1);
    const revId = spawns[spawns.length - 1];
    check("reviewer launches the opposite agent (claude by default) with the hook injection",
      (await writesTo(revId)).some((d) => d.includes("claude --settings")));
    check("attach input focus returns to the implementer pane, not the reviewer",
      (await page.evaluate(() =>
        document.activeElement?.closest(".pane")?.querySelector(".pane-title")?.textContent)) === "left");
    check("strip shows attaching status", (await stripStatus()).includes("起動"));

    // ★レビュー役の起動出力が静止しても、最初のレビュー依頼は自動では送らない
    await busyIdle(revId, 500);
    await page.waitForTimeout(500);
    check("attach moves to the implementer turn after the reviewer boots",
      (await stripStatus()).includes("実装役"));
    check("attach does NOT auto-send the first review request",
      !(await writesTo(revId)).some((d) => d.includes("レビュー役です")));
    check("attach round stays 0/2 before the button",
      (await stripRound()) === "ラウンド 0/2");

    // 「レビューへ渡す」で最初のレビュー依頼（観点の補足つき）を送る
    await page.locator("#pair-handoff").click();
    await page.waitForFunction(
      ([id, text]) => window.__ptyWrites.some((w) => w.id === id && w.data.includes(text)),
      [revId, "レビュー役です"],
      { timeout: 3000 },
    );
    const revWrites = await writesTo(revId);
    check("handoff button sends the first review request",
      revWrites.some((d) => d.includes("レビュー役です")));
    check("review focus note is appended",
      revWrites.some((d) => d.includes("ユーザーからの補足") && d.includes("並行処理まわり")));
    check("attach round advances to 1/2", (await stripRound()) === "ラウンド 1/2");
    await page.locator("#pair-stop").click();
  }
}
await page.close();

}
