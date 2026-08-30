export default async function (ctx) {
  const { browser, check, BASE_URL } = ctx;

  const requiredEula = {
    official: true,
    version: "1.0",
    effectiveDate: "2026-08-24",
    accepted: false,
    url: "https://paralellterminal.com/eula",
    text: "# PATerminal End User License Agreement (EULA)\n\nVersion 1.0\n\nEnglish authoritative text",
    resolvedLocale: "en",
    authoritativeLocale: "en",
    isTranslation: false,
  };

  // 明示同意までは boot() しない。したがってトライアル照会・PTY・session 保存も起きない。
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
    await page.addInitScript((eula) => {
      window.__mockEula = eula;
      window.__mockSessionLoad = JSON.stringify({ version: 5, settings: { language: "en" } });
      window.__mockLicense = {
        official: true,
        state: "licensed",
        locked: false,
        daysLeft: null,
        supporter: false,
        keyMasked: "…MOCK",
        keyKind: "dev",
        retrialAvailable: false,
        banner: null,
        guidePending: false,
        checkoutUrl: "https://example.com/checkout",
      };
      window.__mockOfficialUpdate = {
        currentVersion: "0.2.1",
        version: "0.2.2",
        body: "Signed updater test",
      };
    }, requiredEula);
    await page.goto(BASE_URL);
    await page.waitForSelector("#eula-overlay:not([hidden])", { timeout: 5000 });

    check("official first run blocks before creating a terminal", (await page.locator(".pane").count()) === 0);
    check("official first run has not saved a session", await page.evaluate(() => window.__savedSession === undefined));
    check("bundled EULA text is the English authoritative version",
      (await page.locator("#eula-text").textContent()).includes("English authoritative text"));
    check("English is identified as the sole authoritative locale",
      await page.locator("#eula-overlay").getAttribute("data-authoritative-locale") === "en"
      && await page.locator("#eula-overlay").getAttribute("data-translation") === "false");
    check("agree button starts disabled", await page.locator("#eula-accept").isDisabled());

    await page.click("#eula-open-web");
    await page.waitForFunction(() => (window.__openedUrls ?? []).length === 1);
    check("EULA can be opened on the canonical website",
      (await page.evaluate(() => window.__openedUrls ?? [])).every((url) =>
        url === "https://paralellterminal.com/eula"));

    await page.check("#eula-agree-check");
    await page.click("#eula-accept");
    await page.waitForSelector(".pane", { timeout: 10000 });
    check("acceptance stores the exact EULA version",
      (await page.evaluate(() => window.__eulaAcceptCalls ?? [])).includes("1.0"));
    check("EULA gate closes after acceptance", await page.locator("#eula-overlay").isHidden());

    await page.click("#settings-open");
    await page.click('#settings-nav [data-section="license"]');
    await page.click("#settings-eula-open");
    await page.waitForFunction(() => (window.__openedUrls ?? []).length === 2);
    check("settings keeps the current EULA reachable",
      (await page.evaluate(() => window.__openedUrls ?? [])).every((url) =>
        url === "https://paralellterminal.com/eula"));
    await page.click("#settings-third-party-open");
    await page.waitForSelector("#eula-overlay:not([hidden])");
    check("bundled third-party notices are reachable from settings",
      (await page.locator("#eula-text").textContent()).includes("Mock dependency — MIT"));
    await page.click("#eula-close");
    check("third-party notices can be closed", await page.locator("#eula-overlay").isHidden());

    // 公式ビルドはGitHubページ誘導ではなく、署名付き成果物の取得・検証・再起動を使う。
    await page.click("#settings-open");
    await page.click('#settings-nav [data-section="update"]');
    await page.click("#settings-check-update");
    await page.waitForSelector("#settings-install-update");
    check("official update offers in-app signed installation",
      (await page.locator("#settings-update-result").textContent()).includes("0.2.2"));
    check("official update keeps a manual public Release fallback",
      await page.locator("#settings-open-release").isVisible());
    await page.click("#settings-install-update");
    check("install requires explicit restart confirmation",
      await page.locator("#settings-confirm-install").isVisible());
    await page.click("#settings-cancel-install");
    check("restart confirmation can be cancelled",
      (await page.locator("#settings-confirm-install").count()) === 0);
    await page.click("#settings-install-update");
    await page.click("#settings-confirm-install");
    await page.waitForFunction(() => (window.__officialUpdateInstallCalls ?? []).length === 1);
    check("session state is flushed before updater installation",
      await page.evaluate(() => typeof window.__savedSession === "string"));
    check("signed updater install is invoked once",
      (await page.evaluate(() => window.__officialUpdateInstallCalls ?? [])).length === 1);
    await page.close();
  }

  // 英語は上の実画面で、他16言語は同じ実行bundleの辞書からEULA文言を検証する。
  const localizedTitles = [
    ["ja", "エンドユーザー使用許諾契約"],
    ["zh-Hans", "最终用户许可协议"],
    ["zh-Hant", "終端使用者授權合約"],
    ["ko", "최종 사용자 사용권 계약"],
    ["es", "Contrato de licencia de usuario final"],
    ["pt-BR", "Contrato de Licença de Usuário Final"],
    ["fr", "Contrat de licence utilisateur final"],
    ["de", "Endbenutzer-Lizenzvertrag"],
    ["it", "Contratto di licenza con l’utente finale"],
    ["ru", "Лицензионное соглашение с конечным пользователем"],
    ["ar", "اتفاقية ترخيص المستخدم النهائي"],
    ["hi", "अंतिम उपयोगकर्ता लाइसेंस अनुबंध"],
    ["id", "Perjanjian Lisensi Pengguna Akhir"],
    ["vi", "Thỏa thuận cấp phép người dùng cuối"],
    ["th", "ข้อตกลงสิทธิ์การใช้งานสำหรับผู้ใช้ปลายทาง"],
    ["tr", "Son Kullanıcı Lisans Sözleşmesi"],
  ];
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.goto(BASE_URL);
    const copies = await page.evaluate(async (locales) => {
      const { setLang, t } = await import("/src/i18n/index.ts");
      return locales.map(([locale]) => {
        setLang(locale);
        return [locale, t("eula.title"), t("eula.introTranslation")];
      });
    }, localizedTitles);
    check("all 17 dictionaries contain their localized EULA UI copy",
      copies.every(([locale, title, notice], index) =>
        locale === localizedTitles[index][0]
        && title === localizedTitles[index][1]
        && typeof notice === "string"
        && notice.length > 20));
    await page.close();
  }

  // 日本語とRTLのアラビア語で、保存言語から実画面・本文・Web URLまでを検証する。
  for (const [locale, expectedTitle] of localizedTitles.filter(([locale]) => locale === "ja" || locale === "ar")) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.addInitScript(({ locale, expectedTitle }) => {
      window.__mockSessionLoad = JSON.stringify({ version: 5, settings: { language: locale } });
      window.__mockEula = {
        official: true,
        version: "1.0",
        effectiveDate: "2026-08-24",
        accepted: false,
        url: `https://paralellterminal.com/${locale}/eula`,
        text: `localized EULA body: ${locale}`,
        resolvedLocale: locale,
        authoritativeLocale: "en",
        isTranslation: true,
        expectedTitle,
      };
    }, { locale, expectedTitle });
    await page.goto(BASE_URL);
    await page.waitForSelector("#eula-overlay:not([hidden])", { timeout: 5000 });
    check(`${locale} is requested before boot`,
      (await page.evaluate(() => window.__eulaStatusLocales ?? [])).at(-1) === locale);
    check(`${locale} uses its localized EULA body and UI dictionary`,
      await page.locator("#eula-text").textContent() === `localized EULA body: ${locale}`
      && await page.locator("#eula-title").textContent() === expectedTitle);
    check(`${locale} is marked as an informational translation of English`,
      await page.locator("#eula-overlay").getAttribute("data-locale") === locale
      && await page.locator("#eula-overlay").getAttribute("data-authoritative-locale") === "en"
      && await page.locator("#eula-overlay").getAttribute("data-translation") === "true");
    if (locale === "ar") {
      check("Arabic EULA dialog uses RTL direction", await page.locator("#eula-overlay").getAttribute("dir") === "rtl");
    }
    await page.click("#eula-open-web");
    await page.waitForFunction(() => (window.__openedUrls ?? []).length === 1);
    check(`${locale} opens its localized web EULA`,
      (await page.evaluate(() => window.__openedUrls?.[0])) === `https://paralellterminal.com/${locale}/eula`);
    await page.close();
  }

  // 保存言語がなければOS言語を使う。
  {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "languages", { value: ["ja-JP"], configurable: true });
      window.__mockEula = {
        ...window.__mockEula,
        official: true,
        version: "1.0",
        effectiveDate: "2026-08-24",
        accepted: false,
        url: "https://paralellterminal.com/ja/eula",
        text: "OS locale Japanese EULA",
        resolvedLocale: "ja",
        authoritativeLocale: "en",
        isTranslation: true,
      };
    });
    await page.goto(BASE_URL);
    await page.waitForSelector("#eula-overlay:not([hidden])", { timeout: 5000 });
    check("OS locale selects the first-run EULA when no saved language exists",
      (await page.evaluate(() => window.__eulaStatusLocales ?? [])).at(-1) === "ja");
    await page.close();
  }

  // 拒否は終了要求だけを送り、boot() も永続化も行わない。
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.addInitScript((eula) => {
      window.__mockEula = eula;
    }, requiredEula);
    await page.goto(BASE_URL);
    await page.waitForSelector("#eula-overlay:not([hidden])", { timeout: 5000 });
    await page.click("#eula-decline");
    await page.waitForFunction(() => window.__eulaDeclined === true);
    check("declining sends the quit command", await page.evaluate(() => window.__eulaDeclined === true));
    check("declining never creates a terminal", (await page.locator(".pane").count()) === 0);
    check("declining never saves a session", await page.evaluate(() => window.__savedSession === undefined));
    check("declining never records acceptance", (await page.evaluate(() => window.__eulaAcceptCalls ?? [])).length === 0);
    await page.close();
  }
}
