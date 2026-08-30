export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// v3 復元: 設定（テーマ・言語）
// ============================================================

const pageSet = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageSet.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageSet.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 3,
    activeId: "a",
    collapsedGroups: [],
    settings: { theme: "nord", language: "en", quickPhrases: ["Run the tests"] },
    workspaces: [
      { id: "a", name: "Alpha", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "alpha" } },
    ],
  });
});
await pageSet.goto(BASE_URL);
await pageSet.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageSet.waitForTimeout(300);
const bootBg = await pageSet.evaluate(() =>
  document.documentElement.style.getPropertyValue("--bg").trim());
check("theme restored on boot (nord)", bootBg === "#242933", `--bg=${bootBg}`);
const bootLang = await pageSet.evaluate(() => document.documentElement.lang);
const bootTitle = await pageSet.locator("#ws-new").getAttribute("title");
check("language restored on boot (en)",
  bootLang === "en" && (bootTitle ?? "").includes("New session"),
  `lang=${bootLang} title="${bootTitle}"`);
const restoredChip = await pageSet.locator(".quick-phrase-chip").textContent();
check("restored quick phrases show on the bar at boot", restoredChip === "Run the tests",
  `chip=${JSON.stringify(restoredChip)}`);
await pageSet.click("#quick-phrases-open");
const restoredPhrase = await pageSet.locator(".quick-phrase-use").textContent();
const restoredEdit = await pageSet.locator(".quick-phrase-actions button").first().textContent();
check("quick phrases restore with active language",
  restoredPhrase === "Run the tests" && restoredEdit === "Edit",
  `phrase=${JSON.stringify(restoredPhrase)} edit=${JSON.stringify(restoredEdit)}`);
await pageSet.close();

}
