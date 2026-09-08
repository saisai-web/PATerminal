export default async function ({ browser, check, BASE_URL }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.addInitScript(() => {
    window.__mockGitChanges = { repo: true, root: "/repo", files: [] };
    window.__mockWorktreeBranches = {
      branches: [{ name: "main", reference: "refs/heads/main", current: true }],
      defaultRef: "refs/heads/main",
    };
  });
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane");
  const open = async (root = "/repo") => {
    await page.evaluate(async (root) => {
      const dialog = await import("/src/features/git/worktree-dialog.ts");
      await dialog.openWorktreeDialog({ root });
    }, root);
  };
  const saved = () => page.evaluate(() => JSON.parse(window.__savedSession ?? "null"));
  await open();
  check("automatic branch naming defaults off", await page.inputValue("#worktree-branch") === "");
  await page.locator('#worktree-inherit input[value=no]').check();
  await page.fill("#worktree-note", "破棄するメモ");
  await page.click("#worktree-cancel");
  await page.waitForFunction(() => JSON.parse(window.__savedSession ?? "null")?.settings?.worktree?.inherit === false);
  await open("/other-repo");
  check("cancelled inherit choice applies to another repository and clears note",
    await page.locator('#worktree-inherit input[value=no]').isChecked() && await page.inputValue("#worktree-note") === "");
  await page.click("#worktree-cancel");
  await page.click("#settings-open");
  await page.click('[data-section="worktree"].settings-nav-item');
  check("settings shows inherit choice and auto naming off",
    await page.locator('#settings-worktree-inherit input[value=no]').isChecked() &&
    !await page.locator('#settings-worktree-auto-branch').isChecked());
  await page.locator('#settings-worktree-auto-branch').check();
  await page.click("#settings-close");
  await open();
  const generated = await page.inputValue("#worktree-branch");
  const localDate = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
  });
  check("generated name uses local date, time and six hex digits",
    /^worktree\/\d{8}-\d{6}-[0-9a-f]{6}$/.test(generated) && generated.startsWith(`worktree/${localDate}-`));
  check("generated name updates destination preview", (await page.textContent("#worktree-location")).includes(generated.replaceAll("/", "-")));
  await page.fill("#worktree-branch", "feature/manual");
  await page.locator('#worktree-source input[value=pr]').check();
  await page.locator('#worktree-source input[value=branch]').check();
  check("source switching keeps manual edits", await page.inputValue("#worktree-branch") === "feature/manual");
  await page.fill("#worktree-note", "日本語のメモ\n次の作業");
  check("note allows multiple lines and limits input to 120", await page.locator('#worktree-note').getAttribute('maxlength') === '120');
  await page.evaluate(() => { window.__mockWorktreeResult = { error: "creation failed" }; window.__mockWorktreeCreateDelay = 300; });
  await page.click("#worktree-submit");
  check("note disabled during creation", await page.locator('#worktree-note').isDisabled());
  await page.waitForSelector("#worktree-error:not([hidden])");
  check("failure retains manual name and note",
    await page.inputValue("#worktree-branch") === "feature/manual" && await page.inputValue("#worktree-note") === "日本語のメモ\n次の作業" && await page.locator('#worktree-note').isEnabled());
  await page.evaluate(() => { window.__mockWorktreeResult = { path: "/repo/worktree/manual", branch: "feature/manual" }; });
  await page.click("#worktree-submit");
  await page.waitForSelector("#worktree-overlay", { state: "hidden" });
  check("new session immediately displays its note", await page.textContent(".ws-item.is-active .ws-note-display") === "日本語のメモ\n次の作業");
  await page.locator(".ws-item.is-active .ws-note-display").click();
  await page.locator('.ws-note-popover-input').fill("編集後\n保存する");
  await page.locator('.ws-note-popover-input').press('Enter');
  await page.waitForFunction(() => JSON.parse(window.__savedSession ?? "null")?.workspaces?.some(w => w.note === "編集後\n保存する"));
  const snapshot = await saved();
  check("settings persist alongside edited session note", snapshot.settings.worktree.autoBranchName === true && snapshot.settings.worktree.inherit === false);
  await open();
  check("reopening generates a fresh name and clears note", await page.inputValue('#worktree-branch') !== generated && await page.inputValue('#worktree-note') === "");
  await page.click('#worktree-cancel');
  await page.addInitScript(snapshot => { window.__mockSessionLoad = JSON.stringify(snapshot); }, snapshot);
  await page.reload();
  await page.waitForSelector('.workspace-layer:not([hidden]) .pane');
  check("created and edited note restores", await page.textContent('.ws-item.is-active .ws-note-display') === "編集後\n保存する");
  await open('/restored-repo');
  check("global preferences restore from saved data", /^worktree\//.test(await page.inputValue('#worktree-branch')) && await page.locator('#worktree-inherit input[value=no]').isChecked());
  await page.click('#worktree-cancel');
  await page.click('#settings-open');
  await page.click('[data-section="worktree"].settings-nav-item');
  await page.locator('#settings-worktree-auto-branch').uncheck();
  await page.click('#settings-close');
  await open();
  check("disabling automatic naming returns to an empty branch", await page.inputValue('#worktree-branch') === "");
  await page.fill('#worktree-note', 'あ'.repeat(120));
  await page.locator('#worktree-note').press('End');
  await page.locator('#worktree-note').press('a');
  check("note rejects typing beyond 120 characters", (await page.inputValue('#worktree-note')).length === 120);
  await page.close();
}
