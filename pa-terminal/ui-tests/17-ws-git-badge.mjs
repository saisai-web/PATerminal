export default async function (ctx) {
const { browser, check, BASE_URL } = ctx;

// ============================================================
// サイドバーのセッション git バッジ（repo · ⎇ branch · 差分量）
// ============================================================

const pageBadge = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageBadge.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageBadge.addInitScript(() => {
  window.__mockGitSummary = {
    repo: true, root: "/repo/pa-terminal", branch: "main", fileCount: 3, adds: 42, dels: 10,
  };
});
await pageBadge.goto(BASE_URL);
await pageBadge.waitForSelector(".pane", { timeout: 10000 });
// OSC 7 で cwd 確定 → updateWsGit の即時スイープ → バッジ表示
let badgeShown = true;
await pageBadge.waitForSelector(".ws-item .ws-git:not([hidden])", { timeout: 8000 }).catch(() => { badgeShown = false; });
check("sidebar git badge appears", badgeShown);
if (badgeShown) {
  const badgeText = (await pageBadge.locator(".ws-item .ws-git").first().textContent()) ?? "";
  check("badge shows repo, branch and diff size",
    badgeText.includes("pa-terminal") && badgeText.includes("⎇ main") &&
    badgeText.includes("3") && badgeText.includes("+42") && badgeText.includes("-10"),
    `text="${badgeText}"`);
  // リネーム（インライン編集）中の更新は外科的パッチなので編集を壊さない
  await pageBadge.locator(".ws-item .ws-name").first().dblclick();
  const editBefore = await pageBadge.locator(".ws-item .inline-edit").count();
  await pageBadge.evaluate(() => {
    window.__mockGitSummary = {
      repo: true, root: "/repo/pa-terminal", branch: "abc1234", fileCount: 3, adds: 42, dels: 10,
    };
  });
  // 次の5秒スイープでブランチ表示だけ差し替わる
  await pageBadge.waitForFunction(
    () => document.querySelector(".ws-item .ws-git")?.textContent?.includes("abc1234"),
    undefined, { timeout: 8000 }).catch(() => {});
  const editAfter = await pageBadge.locator(".ws-item .inline-edit").count();
  const badgeText2 = (await pageBadge.locator(".ws-item .ws-git").first().textContent()) ?? "";
  check("badge patches in place during rename",
    editBefore === 1 && editAfter === 1 && badgeText2.includes("abc1234"),
    `edit=${editBefore}->${editAfter} text="${badgeText2}"`);
  await pageBadge.keyboard.press("Escape");
  // リポジトリ名を上、ブランチ名を下の専用行で全文表示。変更数は残す
  await pageBadge.evaluate(() => {
    window.__mockGitSummary = {
      repo: true,
      root: "/repo/extraordinarily-long-repository-name",
      branch: "feature/extraordinarily-long-branch-name",
      fileCount: 12, adds: 420, dels: 108,
    };
  });
  await pageBadge.waitForFunction(
    () => document.querySelector(".ws-item .ws-git")?.textContent?.includes("420"),
    undefined, { timeout: 8000 }).catch(() => {});
  const badgeBox = await pageBadge.locator(".ws-item .ws-git").first().evaluate((el) => {
    const kid = (cls) => {
      const c = el.querySelector(cls);
      if (!c) return null;
      const box = c.getBoundingClientRect();
      return { w: box.width, scroll: c.scrollWidth, top: box.top, bottom: box.bottom };
    };
    return {
      height: el.clientHeight,
      lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      repo: kid(".ws-git-repo"),
      branch: (() => {
        const c = el.querySelector(".ws-git-branch");
        if (!c) return null;
        const style = getComputedStyle(c);
        return {
          w: c.getBoundingClientRect().width,
          scroll: c.scrollWidth,
          height: c.clientHeight,
          scrollHeight: c.scrollHeight,
          lineHeight: Number.parseFloat(style.lineHeight),
          whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap,
          top: c.getBoundingClientRect().top,
        };
      })(),
      del: kid(".ws-git-del"),
    };
  });
  check("git badge shows repo above the full branch name and keeps diff totals visible",
    badgeBox.height > badgeBox.lineHeight * 2 && // リポジトリ行 + ブランチ行
      badgeBox.scrollWidth <= badgeBox.clientWidth + 1 && // 帯自体ははみ出さない
      badgeBox.repo.scroll > badgeBox.repo.w && badgeBox.repo.w > 0 && // repo だけ … で省く
      badgeBox.repo.bottom <= badgeBox.branch.top + 1 && // repo が上、branch が下
      badgeBox.branch.scroll <= badgeBox.branch.w + 1 && // 横方向に隠れない
      badgeBox.branch.scrollHeight <= badgeBox.branch.height + 1 && // 縦方向にも隠れない
      badgeBox.branch.height > badgeBox.branch.lineHeight && // 長い名前は折り返す
      badgeBox.branch.whiteSpace === "normal" && badgeBox.branch.overflowWrap === "anywhere" &&
      badgeBox.del.w >= badgeBox.del.scroll - 1, // 変更数は削られない
    JSON.stringify(badgeBox));
  // リポジトリ外になったらバッジごと消える
  await pageBadge.evaluate(() => {
    window.__mockGitSummary = { repo: false, root: null, branch: null, fileCount: 0, adds: 0, dels: 0 };
  });
  await pageBadge.waitForSelector(".ws-item .ws-git[hidden]", { state: "attached", timeout: 8000 }).catch(() => {});
  check("badge hides outside a repo", await pageBadge.locator(".ws-item .ws-git").first().isHidden());
}
await pageBadge.close();

// セッションごとに全ペインを見て、実際に変更が動いた worktree へ追従する
const pageFollow = await browser.newPage({ viewport: { width: 1280, height: 820 } });
pageFollow.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await pageFollow.addInitScript(() => {
  window.__mockSessionLoad = JSON.stringify({
    version: 4,
    activeId: "session-a",
    groups: [],
    workspaces: [
      {
        id: "session-a", name: "Session A", shellKind: "default", broadcast: false,
        root: {
          kind: "split", dir: "row", ratio: 0.5,
          a: { kind: "leaf", title: "main", cwd: "/repo/main" },
          b: { kind: "leaf", title: "feature", cwd: "/worktrees/feature" },
        },
      },
      {
        id: "session-b", name: "Session B", shellKind: "default", broadcast: false,
        root: {
          kind: "split", dir: "row", ratio: 0.5,
          a: { kind: "leaf", title: "main", cwd: "/repo/main-b" },
          b: { kind: "leaf", title: "bugfix", cwd: "/worktrees/bugfix" },
        },
      },
    ],
  });
  window.__mockGitSummaryByCwd = {
    "/repo/main": {
      repo: true, root: "/repo/main", branch: "main", fileCount: 0, adds: 0, dels: 0,
    },
    "/worktrees/feature": {
      repo: true, root: "/worktrees/feature", branch: "feature/auto-follow",
      fileCount: 2, adds: 12, dels: 3,
    },
    "/repo/main-b": {
      repo: true, root: "/repo/main-b", branch: "main", fileCount: 0, adds: 0, dels: 0,
    },
    "/worktrees/bugfix": {
      repo: true, root: "/worktrees/bugfix", branch: "fix/session-b",
      fileCount: 1, adds: 4, dels: 1,
    },
  };
});
await pageFollow.goto(BASE_URL);
await pageFollow.waitForSelector(".workspace-layer:not([hidden]) .pane", { timeout: 10000 });
await pageFollow.waitForFunction(() => {
  const a = document.querySelector('.ws-item[data-ws-id="session-a"] .ws-git')?.textContent ?? "";
  const b = document.querySelector('.ws-item[data-ws-id="session-b"] .ws-git')?.textContent ?? "";
  return a.includes("feature/auto-follow") && b.includes("fix/session-b");
}, undefined, { timeout: 8000 }).catch(() => {});
const followed = await pageFollow.evaluate(() => ({
  a: document.querySelector('.ws-item[data-ws-id="session-a"] .ws-git')?.textContent ?? "",
  b: document.querySelector('.ws-item[data-ws-id="session-b"] .ws-git')?.textContent ?? "",
  calls: window.__gitSummaryCalls ?? [],
}));
check("sidebar badges follow dirty worktrees across every pane and session",
  followed.a.includes("feature/auto-follow") && followed.b.includes("fix/session-b") &&
    followed.calls.includes("/repo/main") && followed.calls.includes("/worktrees/feature") &&
    followed.calls.includes("/repo/main-b") && followed.calls.includes("/worktrees/bugfix"),
  `a="${followed.a}" b="${followed.b}" calls=${JSON.stringify(followed.calls)}`);

// A の別 worktree に変更が生じたら A だけ切り替え、B の選択は保つ
await pageFollow.evaluate(() => {
  window.__mockGitSummaryByCwd["/repo/main"] = {
    repo: true, root: "/repo/main", branch: "main", fileCount: 1, adds: 7, dels: 0,
  };
});
await pageFollow.waitForFunction(() => {
  const a = document.querySelector('.ws-item[data-ws-id="session-a"] .ws-git')?.textContent ?? "";
  return a.includes("⎇ main") && a.includes("+7");
}, undefined, { timeout: 8000 }).catch(() => {});
const switched = await pageFollow.evaluate(() => ({
  a: document.querySelector('.ws-item[data-ws-id="session-a"] .ws-git')?.textContent ?? "",
  b: document.querySelector('.ws-item[data-ws-id="session-b"] .ws-git')?.textContent ?? "",
}));
check("each session independently switches to the worktree whose changes moved",
  switched.a.includes("⎇ main") && switched.a.includes("+7") && switched.b.includes("fix/session-b"),
  `a="${switched.a}" b="${switched.b}"`);
await pageFollow.close();

}
