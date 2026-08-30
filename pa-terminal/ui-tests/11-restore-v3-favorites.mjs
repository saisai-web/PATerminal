export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// v3 復元: エクスプローラーお気に入り
// ============================================================

const pageFav = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageFav.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageFav.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 3,
    activeId: "b",
    collapsedGroups: ["legacy"],
    explorer: { favorites: ["/home/user/proj", "/tmp"] },
    workspaces: [
      { id: "a", name: "Alpha", group: "legacy", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "alpha" } },
      { id: "b", name: "Beta", shellKind: "default", broadcast: false, root: { kind: "leaf", title: "beta" } },
    ],
  });
});
await pageFav.goto(BASE_URL);
await pageFav.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageFav.waitForTimeout(500);
const favRestored = await pageFav.locator(".exp-fav-row:not(.exp-session-row)").count();
check("favorites restored from v3 session", favRestored === 2, `rows=${favRestored}`);
await pageFav.waitForFunction(() => {
  const raw = window.__savedSession;
  if (!raw) return false;
  const saved = JSON.parse(raw);
  const group = saved.groups?.find((g) => g.name === "legacy");
  return saved.version === 5 && !!group && saved.workspaces.find((w) => w.id === "a")?.group === group.id &&
    saved.collapsedGroups?.includes(group.id);
}, undefined, { timeout: 8000 }).catch(() => {});
const legacySaved = JSON.parse(await pageFav.evaluate(() => window.__savedSession));
const legacyGroup = legacySaved.groups?.find((g) => g.name === "legacy");
check("v3 named groups migrate to v5 IDs",
  legacySaved.version === 5 && legacySaved.workspaces.find((w) => w.id === "a")?.group === legacyGroup?.id &&
    legacySaved.collapsedGroups?.includes(legacyGroup?.id));
await pageFav.locator(".exp-fav-row", { hasText: "tmp" }).click();
await pageFav.waitForTimeout(300);
const favRestNav = await pageFav.locator("#exp-path").textContent();
check("restored favorite navigates", favRestNav === "/tmp", `path="${favRestNav}"`);
await pageFav.close();

}
