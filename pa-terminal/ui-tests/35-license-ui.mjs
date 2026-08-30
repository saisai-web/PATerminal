export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// ライセンスの周辺 UI（Locked 以外）
// - トライアル残バナー: 表示と同時に既読化され、× で閉じる
// - 初回ガイド: トライアル中に出て、閉じたら license_guide_dismiss
// - ライセンス管理モーダル（サイドバーの 🔑）: 状態表示・キー登録（成功 / デバイス上限→解除して続行）・Win-back
// ============================================================

const trialLicense = {
  official: true,
  state: "trial",
  locked: false,
  daysLeft: 7,
  supporter: false,
  keyMasked: null,
  keyKind: null,
  retrialAvailable: false,
  banner: "trial7",
  guidePending: true,
  checkoutUrl: "https://example.com/checkout",
};

// --- トライアルバナー + 初回ガイド ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript((lic) => {
    window.__mockLicense = lic;
  }, trialLicense);
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane", { timeout: 10000 });
  await page.waitForTimeout(600);

  check("trial banner is visible", await page.locator("#license-banner").isVisible());
  check("trial banner mentions the remaining days",
    (await page.locator("#license-banner-text").textContent()).includes("7"));
  const seen = await page.evaluate(() => window.__licenseBannersSeen ?? []);
  check("banner is marked as seen once shown", seen.includes("trial7"), JSON.stringify(seen));
  await page.click("#license-banner-close");
  await page.waitForTimeout(150);
  check("banner close hides the banner", await page.locator("#license-banner").isHidden());

  check("first-run guide is visible during the trial",
    await page.locator("#guide-panel").isVisible());
  await page.click("#guide-close");
  await page.waitForTimeout(150);
  check("guide close hides the panel", await page.locator("#guide-panel").isHidden());
  check("guide dismissal is persisted",
    await page.evaluate(() => window.__licenseGuideDismissed === true));
  await page.close();
}

// --- ライセンス管理モーダル: 状態表示とキー登録（成功） ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript((lic) => {
    window.__mockLicense = { ...lic, banner: null, guidePending: false };
  }, trialLicense);
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane", { timeout: 10000 });
  await page.waitForTimeout(400);

  await page.click("#license-open");
  await page.waitForSelector("#license-manage-overlay:not([hidden])", { timeout: 3000 });
  const stateText = await page.locator("#settings-license-state").textContent();
  check("license modal shows the trial state with days left", stateText.includes("7"), stateText);

  await page.fill("#settings-license-key", "PATERM1.mock.mock");
  await page.click("#settings-license-register");
  await page.waitForTimeout(300);
  const calls = await page.evaluate(() => window.__licenseActivateCalls ?? []);
  check("register sends the key to license_activate",
    calls.includes("PATERM1.mock.mock"), JSON.stringify(calls));
  const stateAfter = await page.locator("#settings-license-state").textContent();
  check("state updates after a successful activation", !stateAfter.includes("7"), stateAfter);
  check("remove button appears once a key is registered",
    await page.locator("#settings-license-remove").isVisible());
  await page.close();
}

// --- ライセンス管理モーダル: デバイス上限 → その場で解除して続行 ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript((lic) => {
    window.__mockLicense = { ...lic, banner: null, guidePending: false };
    window.__mockLicenseActivate = {
      kind: "deviceLimit",
      devices: [
        { id: "dev-1", label: "macOS (day 1)", createdAt: "2026-01-01T00:00:00Z" },
        { id: "dev-2", label: "Windows (day 2)", createdAt: "2026-02-01T00:00:00Z" },
        { id: "dev-3", label: "Linux (day 3)", createdAt: "2026-03-01T00:00:00Z" },
      ],
    };
  }, trialLicense);
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane", { timeout: 10000 });
  await page.waitForTimeout(400);

  await page.click("#license-open");
  await page.waitForSelector("#license-manage-overlay:not([hidden])", { timeout: 3000 });
  await page.fill("#settings-license-key", "PAT-LIMIT-KEY");
  await page.click("#settings-license-register");
  await page.waitForTimeout(300);
  check("device limit shows the device list",
    (await page.locator(".settings-license-device").count()) === 3);
  check("device limit shows an explanatory message",
    await page.locator("#settings-license-msg").isVisible());

  // 解除したら保留中のキーで自動的に再登録される（2回目は成功させる）
  await page.evaluate(() => { window.__mockLicenseActivate = undefined; });
  await page.locator(".settings-license-device button").first().click();
  await page.waitForTimeout(400);
  const removed = await page.evaluate(() => window.__licenseDeviceRemoveCalls ?? []);
  check("remove-and-continue deactivates the picked device",
    removed.includes("dev-1"), JSON.stringify(removed));
  const calls = await page.evaluate(() => window.__licenseActivateCalls ?? []);
  check("activation retries automatically after removal", calls.length === 2,
    JSON.stringify(calls));
  await page.close();
}

// --- Win-back: Locked 30日経過後の再トライアル ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.addInitScript(() => {
    window.__mockLicense = {
      official: true,
      state: "locked",
      locked: true,
      daysLeft: null,
      supporter: false,
      keyMasked: null,
      keyKind: null,
      retrialAvailable: true,
      banner: null,
      guidePending: false,
      checkoutUrl: "https://example.com/checkout",
    };
  });
  await page.goto(BASE_URL);
  await page.waitForSelector(".pane", { timeout: 10000 });
  await page.waitForTimeout(400);

  await page.click("#pair-open"); // ロック入口 → 購入モーダル
  await page.waitForTimeout(200);
  check("purchase modal offers the one-time re-trial",
    await page.locator("#license-retrial").isVisible());
  await page.click("#license-retrial");
  await page.waitForTimeout(300);
  check("re-trial closes the modal", await page.locator("#license-overlay").isHidden());
  check("re-trial unlocks the app",
    await page.evaluate(() => window.__mockLicense.state === "retrial"));
  await page.close();
}
}
