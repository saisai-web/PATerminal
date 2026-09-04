export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// ペアモード（実装役 × レビュー役の相互セッション）
// ハイブリッド受け渡しの検証:
// - 実装役 → レビュー依頼は手動のみ（#pair-handoff。busy→idle では何も送らない）
// - レビュー役 → フィードバック返送は従来どおり自動（+ 手動ボタンでも返せる）
// - ラウンド上限の完了判定も手動（「完了にする」）
// pty:act は __emit で注入する。基本経路はここ、他モードは 29 が担当
// ============================================================

const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.addInitScript(() => {
  // 静止確認デバウンス（実機 6 秒）を短縮してテストのタイミングを保つ（自動側で使う）
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
  const [implId, reviewId] = await page.evaluate(() => window.__ptySpawns.map((s) => s.id));
  const emit = (event, payload) =>
    page.evaluate(([ev, pl]) => window.__emit(ev, pl), [event, payload]);
  const writesTo = (paneId) =>
    page.evaluate((id) => window.__ptyWrites.filter((w) => w.id === id).map((w) => w.data), paneId);
  const writeCount = async (paneId) => (await writesTo(paneId)).length;
  const waitForWrite = (paneId, fragment) => page.waitForFunction(
    ([id, text]) => window.__ptyWrites.some((w) => w.id === id && w.data.includes(text)),
    [paneId, fragment],
    { timeout: 3000 },
  );
  const waitForWriteCount = (paneId, count) => page.waitForFunction(
    ([id, minimum]) => window.__ptyWrites.filter((w) => w.id === id).length >= minimum,
    [paneId, count],
    { timeout: 3000 },
  );
  const waitForText = (selector, fragment) => page.waitForFunction(
    ([sel, text]) => document.querySelector(sel)?.textContent?.includes(text) ?? false,
    [selector, fragment],
    { timeout: 3000 },
  );
  const waitForGitSummary = (cwd) => page.waitForFunction(
    (path) => (window.__gitSummaryCalls ?? []).includes(path),
    cwd,
    { timeout: 3000 },
  );
  const busyIdle = async (paneId, busyMs = 6000, waiting = false) => {
    await emit("pty:act", { id: paneId, busy: true, busyMs: 0, waiting: false });
    await emit("pty:act", { id: paneId, busy: false, busyMs, waiting });
  };

  // ツールバーに入口ボタンがある
  check("pair toolbar button exists", await page.locator("#pair-open").isVisible());
  check("pair toolbar button label", (await page.locator("#pair-open").textContent()).includes("ペア"));

  // モーダルを開くと現在セッションの2ペインが選択肢に入っている
  await page.locator("#pair-open").click();
  check("pair modal opens", await page.locator("#pair-overlay").isVisible());
  check("impl pane select has 2 options",
    (await page.locator("#pair-impl-pane option").count()) === 2);
  check("review pane select has 2 options",
    (await page.locator("#pair-review-pane option").count()) === 2);

  // 既定は「このセッションを置き換え」なので、既存2ペインで組むモードを明示的に選ぶ
  check("replace mode is the default", await page.locator("#pair-mode-replace").isChecked());
  await page.locator("#pair-mode-current").check();
  // ラウンド2・初回タスクつきで開始
  await page.locator("#pair-rounds").fill("2");
  await page.locator("#pair-task").fill("テストタスクを改善して");
  await page.locator("#pair-start").click();
  await page.waitForTimeout(600); // 貼り付け + 250ms 後の Enter を待つ
  check("modal closes on start", await page.locator("#pair-overlay").isHidden());
  check("pair strip appears", await page.locator("#pair-strip").isVisible());
  check("round starts at 0/2",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/2");
  check("impl chip has turn mark",
    await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn")));
  check("toolbar button shows running state",
    await page.locator("#pair-open").evaluate((el) => el.classList.contains("is-on")) &&
      (await page.locator("#pair-open").textContent()).includes("0/2"));

  // 初回タスクが実装役へ入力され、Enter が別送されている
  const implInit = await writesTo(implId);
  check("initial task pasted to implementer", implInit.some((d) => d.includes("テストタスクを改善して")));
  check("initial task submitted with Enter", implInit.some((d) => d === "\r"));

  // 常設の受け渡しボタンが実装ターンのラベルで出ている
  check("handoff button is visible on implementer turn",
    await page.locator("#pair-handoff").isVisible());
  check("handoff button labeled for review handoff",
    (await page.locator("#pair-handoff").textContent()) === "レビューへ渡す");

  // 稼働中にレビュー回数を後から増減できる（ストリップの − / ＋）
  await page.locator("#pair-round-inc").click();
  check("plus raises max rounds",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/3");
  check("toolbar label follows round change",
    (await page.locator("#pair-open").textContent()).includes("0/3"));
  await page.locator("#pair-round-dec").click();
  await page.locator("#pair-round-dec").click();
  check("minus lowers max rounds",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/1");
  check("minus disabled at lower bound", await page.locator("#pair-round-dec").isDisabled());
  await page.locator("#pair-round-inc").click(); // 2 に戻して以降のシナリオを維持
  check("turn-back hidden on implementer turn", await page.locator("#pair-turn-back").isHidden());

  // ★回帰の要: 実装役が長く busy → idle しても、レビュー依頼は自動送信されない
  const reviewBeforeIdle = await writeCount(reviewId);
  await busyIdle(implId);
  await page.waitForTimeout(300); // 静止確認デバウンス(30ms) + 余裕
  check("implementer idle does NOT auto-send the review request",
    (await writeCount(reviewId)) === reviewBeforeIdle &&
      (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/2");
  check("implementer keeps the turn after idle",
    await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn")));

  // waiting（承認ダイアログ）で静止 → 何も送らず表示だけ切り替える
  await busyIdle(implId, 6000, true);
  await waitForText("#pair-strip-status", "応答");
  check("waiting idle sends nothing", (await writeCount(reviewId)) === reviewBeforeIdle);
  check("waiting idle shows approval status",
    (await page.locator("#pair-strip-status").textContent()).includes("応答"));
  await busyIdle(implId); // 応答後の静止で waiting 表示が解ける
  await page.waitForTimeout(100);
  check("status returns to implementer turn after waiting clears",
    (await page.locator("#pair-strip-status").textContent()).includes("実装役"));

  // 一時停止中は受け渡しボタンを隠す
  await page.locator("#pair-pause").click();
  check("paused pair hides the handoff button",
    await page.locator("#pair-handoff").isHidden());
  await page.locator("#pair-pause").click();
  check("resumed pair restores the handoff button",
    await page.locator("#pair-handoff").isVisible());

  // 「レビューへ渡す」でレビュー依頼を送る（手動が唯一の経路）
  const reviewBeforeSend = await writeCount(reviewId);
  await page.locator("#pair-handoff").click();
  await waitForWrite(reviewId, "レビュー役です");
  await waitForWriteCount(reviewId, reviewBeforeSend + 2); // 貼り付け + Enter
  const reviewReq = await writesTo(reviewId);
  check("review request sent to reviewer", reviewReq.some((d) => d.includes("レビュー役です")));
  check("review request submitted with Enter", reviewReq.some((d) => d === "\r"));
  check("round advances to 1/2",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 1/2");
  check("review chip has turn mark",
    await page.locator("#pair-chip-review").evaluate((el) => el.classList.contains("is-turn")));
  check("arrow points to reviewer", (await page.locator("#pair-arrow").textContent()) === "→");
  check("handoff button relabels for feedback",
    (await page.locator("#pair-handoff").textContent()) === "フィードバックを返す");

  // 手動でターンを実装役へ引き戻す（誤送信の回収。何も送信せず、ラウンドも数えない）
  check("turn-back appears on review turn", await page.locator("#pair-turn-back").isVisible());
  const implBeforeBack = await writeCount(implId);
  const reviewBeforeBack = await writeCount(reviewId);
  await page.locator("#pair-turn-back").click();
  check("turn-back returns turn to implementer",
    await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn")));
  check("turn-back refunds the round",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/2");
  check("turn-back hides itself", await page.locator("#pair-turn-back").isHidden());
  check("turn-back sends nothing",
    (await writeCount(implId)) === implBeforeBack &&
      (await writeCount(reviewId)) === reviewBeforeBack);
  // 引き戻した後にレビュー役が静止してもフィードバックは送られない
  await busyIdle(reviewId);
  await page.waitForTimeout(150);
  check("reviewer idle after turn-back sends no feedback",
    (await writeCount(implId)) === implBeforeBack);
  // ボタンからレビュー依頼を送り直せる
  const reviewBeforeRefire = await writeCount(reviewId);
  await page.locator("#pair-handoff").click();
  await waitForText("#pair-strip-round", "ラウンド 1/2");
  await waitForWriteCount(reviewId, reviewBeforeRefire + 2); // 貼り付け + Enter
  check("handoff re-fires after turn-back",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 1/2" &&
      (await page.locator("#pair-chip-review").evaluate((el) => el.classList.contains("is-turn"))));

  // ★返し側は自動: レビュー役が静止 → 画面末尾がフィードバックとして実装役へ戻る
  const implBefore = await writeCount(implId);
  await busyIdle(reviewId);
  await waitForWrite(implId, "フィードバック");
  const implAfter = await writesTo(implId);
  check("feedback sent back to implementer automatically",
    implAfter.length > implBefore && implAfter.some((d) => d.includes("フィードバック")));
  check("turn returns to implementer",
    await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn")));
  // フィードバックの貼り付け + 250ms 後の Enter が流れきるのを待つ
  await page.waitForFunction(
    (id) => {
      const w = window.__ptyWrites.filter((x) => x.id === id);
      return w.length >= 2 && w[w.length - 1].data === "\r";
    },
    implId,
    { timeout: 3000 },
  );

  // 稼働中にモーダルを開くと停止だけが出る（フォームは隠れる）。Escape で閉じる
  await page.locator("#pair-open").click();
  check("running state shows stop-only block",
    (await page.locator("#pair-running").isVisible()) && (await page.locator("#pair-form").isHidden()));
  await page.keyboard.press("Escape");
  check("escape closes pair modal", await page.locator("#pair-overlay").isHidden());

  // 最終ラウンドへ: 手動でレビューへ渡し、手動ボタンでもフィードバックを返せる
  await page.locator("#pair-handoff").click();
  await waitForText("#pair-strip-round", "ラウンド 2/2");
  const implBeforeManualFb = await writeCount(implId);
  check("handoff button offers manual feedback on review turn",
    (await page.locator("#pair-handoff").textContent()) === "フィードバックを返す");
  await page.locator("#pair-handoff").click();
  await waitForWriteCount(implId, implBeforeManualFb + 1);
  check("manual feedback button returns the capture to the implementer",
    (await writesTo(implId)).slice(implBeforeManualFb).some((d) => d.includes("フィードバック")) &&
      (await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn"))));
  await page.waitForFunction(
    ([id, minimum]) => {
      const w = window.__ptyWrites.filter((x) => x.id === id);
      return w.length >= minimum && w[w.length - 1].data === "\r";
    },
    [implId, implBeforeManualFb + 2],
    { timeout: 3000 },
  );

  // ★ラウンド上限の完了も手動: 実装役が静止しても完了にならない
  check("handoff button relabels to finish at max rounds",
    (await page.locator("#pair-handoff").textContent()) === "完了にする");
  await busyIdle(implId);
  await page.waitForTimeout(300);
  check("implementer idle does NOT auto-finish the pair",
    !(await page.locator("#pair-strip-status").textContent()).includes("完了しました") &&
      (await page.locator("#pair-open").evaluate((el) => el.classList.contains("is-on"))));
  await page.locator("#pair-handoff").click();
  await waitForText("#pair-strip-status", "完了");
  check("finish button ends the pair after max rounds",
    (await page.locator("#pair-strip-status").textContent()).includes("完了"));
  check("pause button hidden when done", await page.locator("#pair-pause").isHidden());
  check("round stepper hidden when done",
    (await page.locator("#pair-round-dec").isHidden()) &&
      (await page.locator("#pair-round-inc").isHidden()));
  check("turn-back hidden when done", await page.locator("#pair-turn-back").isHidden());
  check("handoff button hidden when done", await page.locator("#pair-handoff").isHidden());
  check("toolbar button leaves running state",
    !(await page.locator("#pair-open").evaluate((el) => el.classList.contains("is-on"))));

  // 完了後の静止ではもう何も送らない
  const reviewDone = await writeCount(reviewId);
  await busyIdle(implId);
  await page.waitForTimeout(50);
  check("no handoff after done", (await writeCount(reviewId)) === reviewDone);

  // セッション切替でストリップが表示中セッションへ追従する
  await page.locator('.ws-item[data-ws-id="wo"]').click();
  await page.waitForTimeout(200);
  check("strip hidden on other session", await page.locator("#pair-strip").isHidden());
  await page.locator('.ws-item[data-ws-id="wp"]').click();
  await page.waitForTimeout(200);
  check("strip reappears on pair session", await page.locator("#pair-strip").isVisible());

  // 終了ボタンでペアを解消（エージェントには触らない）
  await page.locator("#pair-stop").click();
  await page.waitForTimeout(200);
  check("stop hides the strip", await page.locator("#pair-strip").isHidden());

  // --- レビュー対象（未コミットの変更）が無いままボタンを押した →
  //     レビューへ渡さず、ラウンドも消費しない（誤受け渡し防止） ---
  {
    await page.evaluate(
      ([id, cwd]) => {
        window.__mockPtyCwdById = {
          ...(window.__mockPtyCwdById ?? {}),
          [id]: cwd,
          // レビュー役は別の場所にいても、実装役の変更だけが対象になる。
          [window.__ptySpawns[1]?.id]: "/repo/reviewer",
        };
        window.__mockGitSummaryByCwd = {
          ...(window.__mockGitSummaryByCwd ?? {}),
          [cwd]: { repo: true, root: cwd, branch: "main", fileCount: 0, adds: 0, dels: 0 },
          "/repo/reviewer": { repo: true, root: "/repo/reviewer", branch: "main", fileCount: 99, adds: 99, dels: 0 },
        };
        window.__gitSummaryCalls = [];
        window.__gitWorktreeDiffCalls = [];
      },
      [implId, "/repo/no-changes"],
    );
    await page.locator("#pair-open").click();
    await page.locator("#pair-mode-current").check();
    await page.locator("#pair-rounds").fill("2");
    await page.locator("#pair-task").fill("");
    await page.locator("#pair-start").click();
    await waitForText("#pair-strip-round", "ラウンド 0/2");
    check("empty-diff round restarts at 0/2",
      (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/2");

    const reviewBeforeEmpty = await writeCount(reviewId);
    await page.locator("#pair-handoff").click();
    await waitForGitSummary("/repo/no-changes");
    await waitForText("#pair-strip-status", "渡しませんでした");
    check("no changes to review: nothing sent to reviewer",
      (await writeCount(reviewId)) === reviewBeforeEmpty);
    check("no changes to review: note shown in the status",
      (await page.locator("#pair-strip-status").textContent()).includes("渡しませんでした"));
    // サイドバーの定期監視が直後にレビュー役を走査することがあるため、
    // handoff 自身が最初に実装役の cwd を解決したことを確認する。
    const reviewSummaryCalls = await page.evaluate(() => window.__gitSummaryCalls ?? []);
    check("pair review resolves git summary from the implementer pane",
      reviewSummaryCalls[0] === "/repo/no-changes",
      `calls=${JSON.stringify(reviewSummaryCalls)}`);
    check("no changes to review: round does not advance",
      (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/2");
    check("no changes to review: stays on implementer turn",
      await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn")));

    // 変更が現れればボタンで通常どおりレビューへ進み、ラウンドも進む。実装役の cwd から
    // 取った diff がレビュー役自身の cwd 判定を経由せずそのまま埋め込まれることも確認する
    await page.evaluate(
      ([cwd]) => {
        window.__mockGitSummaryByCwd[cwd] = { repo: true, root: cwd, branch: "main", fileCount: 1, adds: 3, dels: 1 };
        window.__mockGitWorktreeDiff = {
          patch: "diff --git a/foo.ts b/foo.ts\n+console.log('hi')\n",
          adds: 3,
          dels: 1,
          truncated: false,
        };
      },
      ["/repo/no-changes"],
    );
    await page.locator("#pair-handoff").click();
    await waitForWrite(reviewId, "diff --git a/foo.ts b/foo.ts");
    check("changes appear: review request now sent",
      (await writeCount(reviewId)) > reviewBeforeEmpty);
    check("changes appear: round advances to 1/2",
      (await page.locator("#pair-strip-round").textContent()) === "ラウンド 1/2");
    const diffReq = await writesTo(reviewId);
    check("changes appear: the actual diff is embedded in the review request",
      diffReq.some((d) => d.includes("diff --git a/foo.ts b/foo.ts") && d.includes("console.log('hi')")));
    check("changes appear: diff was resolved from the implementer's cwd, not the reviewer's",
      (await page.evaluate(() => window.__gitWorktreeDiffCalls)).includes("/repo/no-changes")
        && !(await page.evaluate(() => window.__gitWorktreeDiffCalls)).includes("/repo/reviewer"));

    await page.locator("#pair-stop").click();
    await page.locator("#pair-strip").waitFor({ state: "hidden" });
    // 次のシナリオへ影響しないようモックを消す
    await page.evaluate(() => {
      window.__mockPtyCwdById = {};
      window.__mockGitSummaryByCwd = {};
      window.__mockGitWorktreeDiff = undefined;
    });
  }

  // --- 新しいペアセッションを作る（1ペインのセッションでは current が無効） ---
  await page.locator('.ws-item[data-ws-id="wo"]').click();
  await page.waitForTimeout(200);
  const spawnsBefore = await page.evaluate(() => window.__ptySpawns.length);
  await page.locator("#pair-open").click();
  check("single-pane session disables current mode",
    (await page.locator("#pair-mode-current").isDisabled()) &&
      (await page.locator("#pair-mode-replace").isChecked()));
  await page.evaluate(() => {
    window.__mockWorktreeList = {
      entries: [
        {
          path: "/tmp/paterminal-feature-worktree",
          branch: "feature/pair-cwd",
          head: "abc1234",
          isMain: false,
          isCurrent: false,
          detached: false,
          bare: false,
          locked: false,
          lockReason: "",
          missing: false,
        },
      ],
    };
  });
  await page.locator("#pair-mode-new").check();
  await page.locator("#pair-new-worktree option[value='/tmp/paterminal-feature-worktree']").waitFor({ state: "attached" });
  check("new pair lists existing worktree branch",
    (await page.locator("#pair-new-worktree").textContent()).includes("feature/pair-cwd"));
  await page.locator("#pair-new-worktree").selectOption("/tmp/paterminal-feature-worktree");
  check("selecting branch switches pair cwd to its worktree path",
    await page.locator("#pair-new-cwd").inputValue() === "/tmp/paterminal-feature-worktree");
  await page.locator("#pair-kind-cross").check();
  check("switching pair kind keeps the selected worktree path",
    await page.locator("#pair-new-cwd").inputValue() === "/tmp/paterminal-feature-worktree");
  await page.locator("#pair-kind-implement").check();
  await page.evaluate(() => {
    window.__mockPickedDirectory = null;
  });
  await page.locator("#pair-new-cwd-browse").click();
  check("cancelling the pair folder dialog keeps the current input",
    (await page.locator("#pair-new-cwd").inputValue()) === "/tmp/paterminal-feature-worktree");
  await page.locator("#pair-new-cwd").fill("/tmp/missing-pair-project");
  const spawnsBeforeInvalidPath = await page.evaluate(() => window.__ptySpawns.length);
  await page.locator("#pair-start").click();
  await page.waitForTimeout(200);
  check("invalid pair folder keeps the setup modal open",
    await page.locator("#pair-overlay").isVisible());
  check("invalid pair folder shows an error",
    await page.locator("#pair-error").isVisible());
  check("invalid pair folder does not spawn panes",
    (await page.evaluate(() => window.__ptySpawns.length)) === spawnsBeforeInvalidPath);
  check("pair folder validation uses the lightweight directory check",
    (await page.evaluate(() => window.__fsIsDirCalls)).includes("/tmp/missing-pair-project"));
  await page.evaluate(() => {
    window.__mockPickedDirectory = "/tmp/pair-project";
  });
  check("new pair mode shows optional folder field",
    await page.locator("#pair-new-cwd-field").isVisible());
  await page.locator("#pair-new-cwd-browse").click();
  check("folder picker fills the pair session path",
    (await page.locator("#pair-new-cwd").inputValue()) === "/tmp/pair-project");
  await page.locator("#pair-start").click();
  await page.waitForFunction(
    (count) => window.__ptySpawns.length >= count + 2,
    spawnsBefore,
    { timeout: 3000 },
  );
  const spawns = await page.evaluate(() => window.__ptySpawns.map((s) => s.id));
  check("pair session spawns two panes", spawns.length === spawnsBefore + 2);
  const [newImpl, newReview] = spawns.slice(-2);
  await waitForWrite(newImpl, "claude");
  await waitForWrite(newReview, "codex");
  check("pair panes use the selected folder",
    (await page.evaluate(([impl, review]) => {
      const rows = window.__ptySpawns.filter((s) => s.id === impl || s.id === review);
      return rows.length === 2 && rows.every((s) => s.cwd === "/tmp/pair-project");
    }, [newImpl, newReview])));
  // 既定コマンド（claude / codex）は完了フック注入付きで起動される
  check("implementer launches claude with the stop-hook injection",
    (await writesTo(newImpl)).some((d) =>
      d.includes("env PATERM_PAIR_SIGNAL='/mock/pair-signals/") &&
      d.includes("claude --settings '/mock/pair-signals/claude-stop-hook.json'")));
  check("reviewer launches codex with the notify injection",
    (await writesTo(newReview)).some((d) =>
      d.includes("env PATERM_PAIR_SIGNAL='/mock/pair-signals/") &&
      d.includes(`codex --no-alt-screen -c 'notify=["/mock/pair-signals/notify.sh"]'`)));
  check("input focus lands on the implementer pane, not the reviewer",
    (await page.evaluate(() =>
      document.activeElement?.closest(".pane")?.querySelector(".pane-title")?.textContent)) === "impl");
  check("new pair session is named automatically",
    (await page.locator('.ws-item', { hasText: "Pair 1" }).count()) === 1);
  check("strip shows starting status",
    (await page.locator("#pair-strip-status").textContent()).includes("起動"));
  // エージェントの起動出力が静止したら実装役のターンへ移る（起動待ちは従来どおり自動）
  await busyIdle(newImpl, 500);
  await waitForText("#pair-strip-status", "実装役");
  check("starting phase moves to implementer turn",
    (await page.locator("#pair-strip-status").textContent()).includes("実装役"));

  // 新規セッションでも実装役の静止では送らず、ボタンで送る
  // （newReview は起動時に Codex のコマンド送信済みなので、レビュー依頼特有の内容で判定する）
  await busyIdle(newImpl);
  await page.waitForTimeout(300);
  check("new pair implementer idle sends nothing",
    !(await writesTo(newReview)).some((d) => d.includes("レビュー役です")));
  check("strip round stays 0 before the button is pressed",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 0/2");
  check("handoff button is available on the new pair",
    await page.locator("#pair-handoff").isVisible());
  await page.locator("#pair-handoff").click();
  await waitForWrite(newReview, "レビュー役です");
  check("handoff button sends the review request",
    (await writesTo(newReview)).some((d) => d.includes("レビュー役です")));
  check("round advances after sending from the strip",
    (await page.locator("#pair-strip-round").textContent()) === "ラウンド 1/2");

  await page.locator("#pair-stop").click();

  // 作成先は表示中ペインの cwd で初期化され、そのまま新規セッションへ渡る
  await page.locator('.ws-item[data-ws-id="wo"]').click();
  await page.waitForTimeout(200);
  const spawnsBeforeFallback = await page.evaluate(() => window.__ptySpawns.length);
  await page.locator("#pair-open").click();
  await page.locator("#pair-mode-new").check();
  check("pair folder defaults to the current session cwd",
    (await page.locator("#pair-new-cwd").inputValue()) === "/home/user");
  await page.locator("#pair-start").click();
  await page.waitForFunction(
    (count) => window.__ptySpawns.length >= count + 2,
    spawnsBeforeFallback,
    { timeout: 3000 },
  );
  const fallbackSpawns = await page.evaluate(() => window.__ptySpawns.slice(-2));
  check("default pair folder is used by both panes",
    fallbackSpawns.length === 2 && fallbackSpawns.every((s) => s.cwd === "/home/user") &&
      (await page.evaluate(() => window.__ptySpawns.length)) === spawnsBeforeFallback + 2);
  await page.locator("#pair-stop").click();

  // --- このセッションをペアセッションにする（中身を置き換え、セッションは残す） ---
  await page.locator('.ws-item[data-ws-id="wo"]').click();
  await page.waitForTimeout(200);
  const wsCountBefore = await page.locator(".ws-item").count();
  const spawnsBeforeReplace = await page.evaluate(() => window.__ptySpawns.length);
  await page.locator("#pair-open").click();
  await page.locator("#pair-mode-replace").check();
  check("replace mode shows command fields",
    (await page.locator("#pair-new-fields").isVisible()) &&
      (await page.locator("#pair-current-fields").isHidden()));
  await page.locator("#pair-start").click();
  await page.waitForFunction(
    (count) => window.__ptySpawns.length >= count + 2,
    spawnsBeforeReplace,
    { timeout: 3000 },
  );
  const replaceSpawns = await page.evaluate(() => window.__ptySpawns.map((s) => s.id));
  check("replace mode spawns two new panes", replaceSpawns.length === spawnsBeforeReplace + 2);
  const [repImpl, repReview] = replaceSpawns.slice(-2);
  await waitForWrite(repImpl, "claude");
  await waitForWrite(repReview, "codex");
  check("replace implementer launches claude",
    (await writesTo(repImpl)).some((d) => d.includes("claude --settings")));
  check("replace reviewer launches codex",
    (await writesTo(repReview)).some((d) => d.includes("codex --no-alt-screen -c")));
  check("old pane is closed and two new panes remain",
    (await page.locator('.workspace-layer:not([hidden]) .pane').count()) === 2);
  check("replace input focus lands on the implementer pane, not the reviewer",
    (await page.evaluate(() =>
      document.activeElement?.closest(".pane")?.querySelector(".pane-title")?.textContent)) === "impl");
  check("no new session is created", (await page.locator(".ws-item").count()) === wsCountBefore);
  check("session keeps its name",
    (await page.locator('.ws-item[data-ws-id="wo"] .ws-name').textContent()) === "Other");
  check("strip shows starting status after replace",
    (await page.locator("#pair-strip-status").textContent()).includes("起動"));
  await page.locator("#pair-stop").click();

  // --- 完了シグナル（agent:turn）: 注入されたフック由来の通知で全自動に受け渡す ---
  {
    await page.locator('.ws-item[data-ws-id="wo"]').click();
    await page.waitForTimeout(200);
    const spawnsBeforeSig = await page.evaluate(() => window.__ptySpawns.length);
    await page.locator("#pair-open").click();
    await page.locator("#pair-mode-replace").check();
    await page.locator("#pair-rounds").fill("1");
    await page.locator("#pair-task").fill("シグナル検証タスク");
    await page.locator("#pair-start").click();
    await page.waitForFunction(
      (count) => window.__ptySpawns.length >= count + 2,
      spawnsBeforeSig,
      { timeout: 3000 },
    );
    const [sigImpl, sigReview] =
      (await page.evaluate(() => window.__ptySpawns.map((s) => s.id))).slice(-2);
    await waitForWrite(sigImpl, "--settings");
    await waitForWrite(sigReview, "notify.sh");
    const implRun = (await writesTo(sigImpl)).find((d) => d.includes("PATERM_PAIR_SIGNAL"));
    const reviewRun = (await writesTo(sigReview)).find((d) => d.includes("PATERM_PAIR_SIGNAL"));
    const implToken = implRun?.match(/PATERM_PAIR_SIGNAL='\/mock\/pair-signals\/([0-9a-f-]+)'/)?.[1];
    const reviewToken = reviewRun?.match(/PATERM_PAIR_SIGNAL='\/mock\/pair-signals\/([0-9a-f-]+)'/)?.[1];
    check("both panes carry a per-pane signal token",
      Boolean(implToken && reviewToken && implToken !== reviewToken));

    // 起動出力の静止（従来経路）で初回タスクが実装役へ入る
    await busyIdle(sigImpl, 500);
    await waitForWrite(sigImpl, "シグナル検証タスク");
    await page.waitForFunction(
      (id) => {
        const w = window.__ptyWrites.filter((x) => x.id === id);
        return w.length >= 2 && w[w.length - 1].data === "\r";
      },
      sigImpl,
      { timeout: 3000 },
    );
    check("status notes the auto handoff for the signal-managed turn",
      (await page.locator("#pair-strip-status").textContent()).includes("自動受け渡し"));

    // ★シグナル管理ペインは静止検知を使わない: busy/idle を emit しても何も送らない
    await busyIdle(sigImpl);
    await page.waitForTimeout(300);
    check("signal-managed implementer ignores idle detection",
      !(await writesTo(sigReview)).some((d) => d.includes("レビュー役です")));

    // agent:turn（完了フック）で diff を確定してレビューへ自動受け渡し
    await page.evaluate(
      ([id, cwd]) => {
        window.__mockPtyCwdById = { [id]: cwd };
        window.__mockGitSummaryByCwd = {
          [cwd]: { repo: true, root: cwd, branch: "main", fileCount: 1, adds: 1, dels: 0 },
        };
        window.__mockGitWorktreeDiff =
          { patch: "diff --git a/sig.ts b/sig.ts\n+sig\n", adds: 1, dels: 0, truncated: false };
      },
      [sigImpl, "/repo/sig"],
    );
    await emit("agent:turn", { token: implToken });
    await waitForWrite(sigReview, "レビュー役です");
    check("agent:turn hands off to review automatically",
      (await page.locator("#pair-strip-round").textContent()) === "ラウンド 1/1");

    // 消費済みトークンの再通知は何も起こさない（pendingTurn ゲート）
    const reviewAfterHandoff = await writeCount(sigReview);
    await emit("agent:turn", { token: implToken });
    await page.waitForTimeout(200);
    check("consumed turn signal is ignored",
      (await writeCount(sigReview)) === reviewAfterHandoff &&
        (await page.locator("#pair-strip-round").textContent()) === "ラウンド 1/1");

    // レビュー依頼の貼り付け + Enter が流れきる（= レビュー役のターンが armed になる）
    await page.waitForFunction(
      (id) => {
        const w = window.__ptyWrites.filter((x) => x.id === id);
        return w.length >= 2 && w[w.length - 1].data === "\r";
      },
      sigReview,
      { timeout: 3000 },
    );
    // waiting（承認ダイアログ）中のシグナルは無視する（自動では絶対に答えない）
    await busyIdle(sigReview, 500, true);
    const implBeforeWait = await writeCount(sigImpl);
    await emit("agent:turn", { token: reviewToken });
    await page.waitForTimeout(200);
    check("turn signal is ignored while waiting for approval",
      (await writeCount(sigImpl)) === implBeforeWait);

    // 応答後のシグナルでフィードバックが自動で実装役へ返る
    await busyIdle(sigReview, 500);
    await emit("agent:turn", { token: reviewToken });
    await waitForWrite(sigImpl, "フィードバック");
    check("agent:turn returns the feedback automatically",
      await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn")));

    // 最終ラウンド（round = max）の実装役シグナルで自動完了
    await page.waitForFunction(
      ([id, minimum]) => {
        const w = window.__ptyWrites.filter((x) => x.id === id);
        return w.length >= minimum && w[w.length - 1].data === "\r";
      },
      [sigImpl, implBeforeWait + 2],
      { timeout: 3000 },
    );
    await emit("agent:turn", { token: implToken });
    await waitForText("#pair-strip-status", "完了");
    check("final turn signal auto-finishes the pair",
      (await page.locator("#pair-strip-status").textContent()).includes("完了"));

    await page.locator("#pair-stop").click();
    await page.locator("#pair-strip").waitFor({ state: "hidden" });
    // 停止後の迷子シグナルは無視される
    await emit("agent:turn", { token: implToken });
    await page.waitForTimeout(100);
    check("stray signal after stop is ignored", await page.locator("#pair-strip").isHidden());
    await page.evaluate(() => {
      window.__mockPtyCwdById = {};
      window.__mockGitSummaryByCwd = {};
      window.__mockGitWorktreeDiff = undefined;
    });
  }

  // --- bracketed paste（pty:mode）と Enter ウォッチドッグ ---
  {
    await page.locator('.ws-item[data-ws-id="wp"]').click();
    await page.waitForTimeout(200);
    // Rust の DECSET 2004 追跡を注入: レビュー役の TUI が bracketed paste を有効化した
    await emit("pty:mode", { id: reviewId, bracketedPaste: true });
    // 実装役に変更ありのモック（レビュー依頼へ diff が埋まる通常経路）
    await page.evaluate(
      ([id, cwd]) => {
        window.__mockPtyCwdById = { [id]: cwd };
        window.__mockGitSummaryByCwd = {
          [cwd]: { repo: true, root: cwd, branch: "main", fileCount: 1, adds: 1, dels: 0 },
        };
        window.__mockGitWorktreeDiff =
          { patch: "diff --git a/bp.ts b/bp.ts\n+bp\n", adds: 1, dels: 0, truncated: false };
      },
      [implId, "/repo/bp"],
    );
    await page.locator("#pair-open").click();
    await page.locator("#pair-mode-current").check();
    await page.locator("#pair-rounds").fill("2");
    await page.locator("#pair-task").fill("");
    await page.locator("#pair-start").click();
    await waitForText("#pair-strip-round", "ラウンド 0/2");

    const reviewBeforeBp = await writeCount(reviewId);
    await page.locator("#pair-handoff").click();
    await waitForWrite(reviewId, "レビュー役です");
    await waitForWriteCount(reviewId, reviewBeforeBp + 2); // 貼り付け + Enter
    const bpWrites = (await writesTo(reviewId)).slice(reviewBeforeBp);
    check("review request is wrapped in bracketed paste markers",
      bpWrites.some((d) => d.startsWith("[200~") && d.endsWith("[201~")));
    check("Enter stays a separate bare CR outside the markers",
      bpWrites.some((d) => d === "\r"));

    // waiting（承認ダイアログ）の静止では Enter を再送しない
    const reviewBeforeRetry = await writeCount(reviewId);
    await busyIdle(reviewId, 500, true);
    await page.waitForTimeout(100);
    check("waiting idle does not re-send Enter",
      (await writeCount(reviewId)) === reviewBeforeRetry);

    // 短い静止（貼り付けエコーの描画だけで実働なし = Enter が飲まれた）→ Enter だけ再送
    await busyIdle(reviewId, 500);
    await waitForWriteCount(reviewId, reviewBeforeRetry + 1);
    check("swallowed Enter is re-sent on a short idle",
      (await writesTo(reviewId)).slice(reviewBeforeRetry).every((d) => d === "\r"));
    await busyIdle(reviewId, 500);
    await waitForWriteCount(reviewId, reviewBeforeRetry + 2);
    // 3回目の短い静止では再送しない（上限2回で打ち切り）
    await busyIdle(reviewId, 500);
    await page.waitForTimeout(150);
    check("Enter retry stops after the limit",
      (await writeCount(reviewId)) === reviewBeforeRetry + 2);

    // 実働つきの静止では再送せず通常の自動返送が動く（フィードバック返送）。
    // 過去シナリオの書き込みにも「フィードバック」が含まれるため、件数の増分で待つ
    const implBeforeFeedback = await writeCount(implId);
    await busyIdle(reviewId);
    await waitForWriteCount(implId, implBeforeFeedback + 1);
    check("long idle resumes the automatic feedback instead of retrying",
      (await writesTo(implId)).slice(implBeforeFeedback).some((d) => d.includes("フィードバック")) &&
        (await page.locator("#pair-chip-impl").evaluate((el) => el.classList.contains("is-turn"))));
    // フィードバックの貼り付け + Enter が流れきるのを待つ
    await waitForWriteCount(implId, implBeforeFeedback + 2);

    // pty:mode の無効化（DECRST 2004）で生送信へ戻る（2ラウンド目もボタンから）
    await emit("pty:mode", { id: reviewId, bracketedPaste: false });
    const reqCountBefore =
      (await writesTo(reviewId)).filter((d) => d.includes("レビュー役です")).length;
    await page.locator("#pair-handoff").click();
    await waitForText("#pair-strip-round", "ラウンド 2/2");
    // 貼り付けの記録は非同期なので、ラウンド表示ではなく書き込み自体を待つ
    await page.waitForFunction(
      ([id, minimum]) =>
        window.__ptyWrites.filter((w) => w.id === id && w.data.includes("レビュー役です")).length >=
        minimum,
      [reviewId, reqCountBefore + 1],
      { timeout: 3000 },
    );
    const reviewReqs = (await writesTo(reviewId)).filter((d) => d.includes("レビュー役です"));
    check("mode off returns to raw paste",
      reviewReqs.length >= 2 && !reviewReqs[reviewReqs.length - 1].includes("[200~"));

    await page.locator("#pair-stop").click();
    await page.locator("#pair-strip").waitFor({ state: "hidden" });
    await page.evaluate(() => {
      window.__mockPtyCwdById = {};
      window.__mockGitSummaryByCwd = {};
      window.__mockGitWorktreeDiff = undefined;
    });
  }
}
await page.close();

// --- 静止確認デバウンス（返し側の自動転送）: 確認待ち中に出力が再開したら取り消す ---
// （__pairTuning はモジュール読み込み時に固定されるため、確認待ちを観測できる
//   長さ = 500ms の専用ページで検証する）
{
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page2.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page2.addInitScript(() => {
    window.__pairTuning = { handoffConfirmMs: 500 };
    window.__mockSessionLoad = JSON.stringify({
      version: 3,
      activeId: "wp",
      settings: { language: "ja" },
      workspaces: [
        { id: "wp", name: "PairWs", shellKind: "default", broadcast: false,
          root: { kind: "split", dir: "row", ratio: 0.5,
            a: { kind: "leaf", title: "left" }, b: { kind: "leaf", title: "right" } } },
      ],
    });
  });
  await page2.goto(BASE_URL);
  await page2.waitForSelector(".pane", { timeout: 10000 });
  await page2.waitForTimeout(600);
  const [implId2, reviewId2] = await page2.evaluate(() => window.__ptySpawns.map((s) => s.id));
  const emit2 = (event, payload) =>
    page2.evaluate(([ev, pl]) => window.__emit(ev, pl), [event, payload]);
  const implWrites2 = () =>
    page2.evaluate((id) => window.__ptyWrites.filter((w) => w.id === id).length, implId2);

  await page2.locator("#pair-open").click();
  await page2.locator("#pair-mode-current").check();
  await page2.locator("#pair-rounds").fill("2");
  await page2.locator("#pair-task").fill("デバウンス検証タスク");
  await page2.locator("#pair-start").click();
  await page2.waitForFunction(
    () => document.querySelector("#pair-strip-round")?.textContent === "ラウンド 0/2",
    undefined,
    { timeout: 3000 },
  );
  await page2.waitForTimeout(600); // 初回タスクの貼り付け + 250ms 後の Enter を待つ

  // ボタンでレビューへ渡してレビュー役のターンにする
  await page2.locator("#pair-handoff").click();
  await page2.waitForFunction(
    () => document.querySelector("#pair-strip-round")?.textContent === "ラウンド 1/2",
    undefined,
    { timeout: 3000 },
  );
  // レビュー依頼の貼り付け + 250ms 後の Enter を待つ（レビュー役が engaged になる）
  await page2.waitForFunction(
    (id) => {
      const w = window.__ptyWrites.filter((x) => x.id === id);
      return w.length >= 2 && w[w.length - 1].data === "\r";
    },
    reviewId2,
    { timeout: 3000 },
  );

  // 静止(6000) → 確認待ちの 500ms 以内に出力が再開 → フィードバックは返さない
  // （思考待ちの一時的な沈黙で中途半端なレビューを実装役へ渡さない）
  const before2 = await implWrites2();
  await emit2("pty:act", { id: reviewId2, busy: true, busyMs: 0, waiting: false });
  await emit2("pty:act", { id: reviewId2, busy: false, busyMs: 6000, waiting: false });
  await page2.waitForTimeout(150);
  await emit2("pty:act", { id: reviewId2, busy: true, busyMs: 0, waiting: false });
  await page2.waitForTimeout(800);
  check("resumed reviewer output cancels the pending feedback",
    (await implWrites2()) === before2 &&
      (await page2.locator("#pair-strip-round").textContent()) === "ラウンド 1/2");

  // そのまま静止が続けば、確認待ちの後にフィードバックが実装役へ届く
  await emit2("pty:act", { id: reviewId2, busy: false, busyMs: 6000, waiting: false });
  await page2.waitForFunction(
    ([id, text]) => window.__ptyWrites.some((w) => w.id === id && w.data.includes(text)),
    [implId2, "フィードバック"],
    { timeout: 3000 },
  );
  check("feedback fires after the idle confirmation delay",
    (await page2.locator("#pair-strip-status").textContent()).includes("実装役"));
  await page2.close();
}

}
