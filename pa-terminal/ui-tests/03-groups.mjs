export default async function (ctx) {
const { page, check, MOD } = ctx;

// ============================================================
// セッショングループ
// ============================================================

// --- 18. グループ指定でセッション作成 → 見出し + インデント表示 ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.fill("#ws-new-name", "api");
await page.fill("#ws-new-group", "work");
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
await page.keyboard.press(`${MOD}+KeyT`);
await page.fill("#ws-new-name", "web");
await page.fill("#ws-new-group", "work");
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
const groupName = await page.locator(".ws-group-name").first().textContent();
const groupCount = await page.locator(".ws-group .ws-group-count").first().textContent();
const groupedItems = await page.locator(".ws-group-members .ws-item").count();
check("session created with group header", groupName === "work", `group="${groupName}"`);
check("group header shows member count", groupCount === "2", `count=${groupCount}`);
check("group members indented under header", groupedItems === 2, `members=${groupedItems}`);

// --- 19. 既存グループが入力補完（datalist）に出る ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForTimeout(100);
const datalist = await page.evaluate(() =>
  [...document.querySelectorAll("#ws-group-list option")].map((o) => o.value));
check("existing group offered as completion", datalist.includes("work"), `options=${JSON.stringify(datalist)}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);

// --- 20. 見出しクリックで折りたたみ / 展開 ---
await page.locator(".ws-group").first().click();
await page.waitForTimeout(100);
const collapsedHidden = await page.locator(".ws-group-members").first().isHidden();
const arrowCollapsed = await page.locator(".ws-group-arrow").first().textContent();
check("group collapses on header click", collapsedHidden && arrowCollapsed === "▸",
  `hidden=${collapsedHidden} arrow=${arrowCollapsed}`);

// --- 21. 折りたたみ状態が保存される（v5 group ID + collapsedGroups） ---
// 保存はアイドルスライスで走るため完了までまつ（固定 wait では不足する）
await page.waitForFunction(() => {
  const s = window.__savedSession;
  if (!s) return false;
  const saved = JSON.parse(s);
  const group = saved.groups?.find((g) => g.name === "work");
  return !!group && (saved.collapsedGroups ?? []).includes(group.id);
}, undefined, { timeout: 8000 }).catch(() => {});
const savedGrp = JSON.parse(await page.evaluate(() => window.__savedSession));
const savedWorkGroup = savedGrp.groups?.find((g) => g.name === "work");
check("collapsed state persisted in v5",
  savedGrp.version === 5 && !!savedWorkGroup && savedGrp.collapsedGroups?.includes(savedWorkGroup.id),
  `collapsedGroups=${JSON.stringify(savedGrp.collapsedGroups)}`);

// --- 22. 折りたたみ中グループのセッションをショートカットでアクティブ化 → 自動展開 ---
await page.keyboard.press(`${MOD}+Digit1`); // 別セッションへ（未分類）
await page.waitForTimeout(200);
await page.keyboard.press(`${MOD}+Digit2`); // 折りたたみ中グループの "api"
await page.waitForTimeout(300);
const expandedAfter = await page.locator(".ws-group-members").first().isVisible();
const activeAfterJump = await page.locator(".ws-item.is-active .ws-name").textContent();
check("collapsed group auto-expands when member activated", expandedAfter && activeAfterJump === "api",
  `visible=${expandedAfter} active="${activeAfterJump}"`);

// --- 22b. + の既定行は表示中セッションと同じグループの直後へ作る ---
const beforePlusCreate = await page.locator(".ws-item").count();
await page.click("#ws-new");
check("+ flyout does not create before choosing its default action",
  (await page.locator(".ws-item").count()) === beforePlusCreate);
await page.locator("#loc-flyout .loc-row", { hasText: "表示中ペインと同じ場所" }).click();
await page.waitForTimeout(400);
const plusInGroupName = await page.locator(".ws-item.is-active .ws-name").textContent();
const groupOrder = await page.locator(".ws-group-members .ws-item .ws-name").allTextContents();
check("+ default action creates the session inside the active session's group",
  groupOrder.join(",") === `api,${plusInGroupName},web`,
  `order=${JSON.stringify(groupOrder)} new="${plusInGroupName}"`);
const plusInGroupItem = page.locator(".ws-item", { hasText: plusInGroupName ?? "" });
await plusInGroupItem.hover();
await plusInGroupItem.locator(".ws-close").click();
await page.waitForTimeout(300);

// --- 22c. Cmd/Ctrl+T も表示中セッションと同じ階層を既定にし、直後へ作る ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.waitForTimeout(100);
const formDefaultGroup = await page.locator("#ws-new-group").inputValue();
check("new-session form defaults to the active session's group",
  formDefaultGroup === "work", `group="${formDefaultGroup}"`);
await page.fill("#ws-new-name", "form-sibling");
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
const formSiblingOrder = await page.locator(".ws-group-members .ws-item .ws-name").allTextContents();
check("new-session form creates beside the active grouped session",
  formSiblingOrder.join(",") === "api,form-sibling,web",
  `order=${JSON.stringify(formSiblingOrder)}`);
const formSiblingItem = page.locator(".ws-item", { hasText: "form-sibling" });
await formSiblingItem.hover();
await formSiblingItem.locator(".ws-close").click();
await page.waitForTimeout(300);

// --- 23. セッションメニューにグループ割当 UI は無い / グループ見出し右クリックで解散 ---
const sess1 = page.locator(".ws-item", { hasText: "Session 1" });
await sess1.click({ button: "right" });
await page.waitForTimeout(150);
check("context menu opens on right-click", await page.locator("#ctx-menu").isVisible());
const ctxInputs = await page.locator("#ctx-menu input").count();
check("no group-assign UI in session menu", ctxInputs === 0, `inputs=${ctxInputs}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
// 解散テスト用の一時グループを新規セッションフォームで作る
// 右クリック元の常設メモ input にフォーカスが残るとアプリのショートカット抑止が働く。
await page.locator(".workspace-layer:not([hidden]) .pane-body").first().click();
await page.keyboard.press(`${MOD}+KeyT`);
await page.fill("#ws-new-name", "tmp1");
await page.fill("#ws-new-group", "misc");
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
check("temp group created via new-session form",
  (await page.locator(".ws-group-name", { hasText: "misc" }).count()) === 1);
await page.locator(".ws-group", { hasText: "misc" }).click({ button: "right" });
await page.waitForTimeout(150);
check("group header right-click opens menu", await page.locator("#ctx-menu").isVisible());
await page.locator("#ctx-menu button", { hasText: "グループを解散" }).click();
await page.waitForTimeout(200);
const miscGone = await page.locator(".ws-group-name", { hasText: "misc" }).count();
const tmp1Still = await page.locator(".ws-item", { hasText: "tmp1" }).count();
check("dissolve removes group but keeps sessions", miscGone === 0 && tmp1Still === 1,
  `headers=${miscGone} items=${tmp1Still}`);
// 後続テストの状態を汚さないよう一時セッションは閉じる（× はホバー時のみ表示）
const tmp1Item = page.locator(".ws-item", { hasText: "tmp1" });
await tmp1Item.hover();
await tmp1Item.locator(".ws-close").click();
await page.waitForTimeout(300);

// --- 23a. 「グループごと全セッションを閉じる」= グループも所属セッションも消える ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.fill("#ws-new-name", "tmp2");
await page.fill("#ws-new-group", "misc2");
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
await page.keyboard.press(`${MOD}+KeyT`);
await page.fill("#ws-new-name", "tmp3");
await page.fill("#ws-new-group", "misc2");
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(400);
const itemsBeforeCloseAll = await page.locator(".ws-item").count();
await page.locator(".ws-group", { hasText: "misc2" }).click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "グループごと全セッションを閉じる" }).click();
await page.waitForTimeout(600);
const misc2Gone = await page.locator(".ws-group-name", { hasText: "misc2" }).count();
const itemsAfterCloseAll = await page.locator(".ws-item").count();
check("close-all removes group and its sessions",
  misc2Gone === 0 && itemsAfterCloseAll === itemsBeforeCloseAll - 2,
  `headers=${misc2Gone} items ${itemsBeforeCloseAll}→${itemsAfterCloseAll}`);

// --- 23a2. セッション右クリック: 対象を包む親グループを即時作成 ---
await page.keyboard.press(`${MOD}+KeyT`);
await page.fill("#ws-new-name", "wrap-target");
await page.fill("#ws-new-group", ""); // 新しい同階層の既定値を明示的に外してトップレベルへ作る
await page.locator("#ws-new-shells button").first().click();
await page.waitForTimeout(350);
const rootRowsBeforeWrap = await page
  .locator(".ws-whole-members > .ws-item, .ws-whole-members > .ws-group")
  .evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
const wrapTargetRow = rootRowsBeforeWrap.findIndex((row) => row.includes("wrap-target"));
await page.locator(".ws-item", { hasText: "wrap-target" }).click({ button: "right" });
await page.waitForTimeout(150);
const sessionCtxLabels = await page.locator("#ctx-menu button").allTextContents();
check("session context offers only create-group",
  !sessionCtxLabels.includes("セッションを作成") && sessionCtxLabels.includes("グループを作成"),
  `labels=${JSON.stringify(sessionCtxLabels)}`);
await page.locator("#ctx-menu button", { hasText: "グループを作成" }).click();
await page.waitForTimeout(200);
check("create-group makes the group silently (no form, no inline editor)",
  !(await page.locator("#ws-new-form").isVisible()) &&
    (await page.locator(".inline-edit").count()) === 0,
  `form=${await page.locator("#ws-new-form").isVisible()} editors=${await page.locator(".inline-edit").count()}`);
// 名前は Group N の自動採番。以降は名前で辿るので見出しメニューからリネームする
const wrappedMembers = page
  .locator(".ws-group-members")
  .filter({ has: page.locator(".ws-item", { hasText: "wrap-target" }) });
const autoHead = wrappedMembers.locator("xpath=preceding-sibling::div[1]");
const autoGroupName = await autoHead.locator(".ws-group-name").textContent();
check("new parent group contains the clicked session and is auto-numbered",
  (await autoHead.count()) === 1 && /^Group \d+$/.test(autoGroupName ?? ""),
  `name="${autoGroupName}"`);
const rootRowsAfterWrap = await page
  .locator(".ws-whole-members > .ws-item, .ws-whole-members > .ws-group")
  .evaluateAll((rows) => rows.map((row) => row.textContent ?? ""));
check("new parent group keeps the clicked session's row position",
  rootRowsAfterWrap.findIndex((row) => row.includes(autoGroupName ?? "")) === wrapTargetRow,
  `before=${JSON.stringify(rootRowsBeforeWrap)} after=${JSON.stringify(rootRowsAfterWrap)}`);
await autoHead.click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "名前を変更" }).click();
await page.waitForTimeout(150);
check("group header menu can start the inline rename",
  (await page.locator(".ws-group-name .inline-edit").count()) === 1);
await page.fill(".ws-group-name .inline-edit", "fresh");
await page.locator(".ws-group-name .inline-edit").press("Enter");
await page.waitForTimeout(200);
const freshName = page.locator(".ws-group-name", { hasText: "fresh" });
const freshHead = freshName.locator("..");
const freshId = await freshHead.getAttribute("data-group-id");
check("group rename from the header menu takes effect", (await freshName.count()) === 1);

// 表示中セッションとは別の見出しを操作しても、挿入位置は見出し直下になる。
await page.locator(".ws-item", { hasText: "Session 1" }).click();
await page.waitForTimeout(100);
// 見出し右端の作成欄から、そのグループ直下へセッションを作る。
// 表示中セッションの選択とは独立し、左クリックだけで作成先を指定できる。
const freshCreate = freshHead.locator(".ws-group-create");
check("group header exposes a clickable create control",
  await freshCreate.isVisible(),
  `count=${await freshCreate.count()}`);
await freshCreate.click();
await page.waitForTimeout(150);
const groupCtxLabels = await page.locator("#ctx-menu button").allTextContents();
check("clickable group create control offers create-session and create-group",
  groupCtxLabels.some((label) => label.startsWith("セッションを作成")) &&
    groupCtxLabels.includes("グループを作成"),
  `labels=${JSON.stringify(groupCtxLabels)}`);
await page.locator("#ctx-menu button", { hasText: "セッションを作成" }).click();
await page.waitForTimeout(400);
const freshMemberNames = await page
  .locator(`.ws-group[data-group-id="${freshId}"] + .ws-group-members > .ws-item .ws-name`)
  .allTextContents();
const freshSessionName = (await page.locator(".ws-item.is-active .ws-name").textContent()) ?? "";
check("group create-session makes an auto-named session in that group without a form",
  !(await page.locator("#ws-new-form").isVisible()) &&
    /^Session \d+$/.test(freshSessionName) &&
    freshMemberNames[0] === freshSessionName,
  `name="${freshSessionName}" members=${JSON.stringify(freshMemberNames)}`);

// 同じ作成欄のグループ作成は子階層になる
// セッション作成で active が対象グループへ移った後も、別階層へ戻して見出し指定を検証する。
await page.locator(".ws-item", { hasText: "Session 1" }).click();
await page.waitForTimeout(100);
await freshCreate.click();
await page.waitForTimeout(100);
await page.locator("#ctx-menu button", { hasText: "グループを作成" }).click();
await page.waitForTimeout(250);
const childHead = page.locator(
  `.ws-group[data-group-id="${freshId}"] + .ws-group-members > .ws-group`,
);
const childId = await childHead.getAttribute("data-group-id");
const firstFreshChildGroupId = await page
  .locator(`.ws-group[data-group-id="${freshId}"] + .ws-group-members`)
  .evaluate((members) => members.firstElementChild?.getAttribute("data-group-id"));
check("group context creates a nested child group silently",
  !(await page.locator("#ws-new-form").isVisible()) && !!childId && firstFreshChildGroupId === childId,
  `childId=${childId} first=${firstFreshChildGroupId}`);
// 保存内容を名前で検証するので子グループもリネームしておく
await childHead.click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "名前を変更" }).click();
await page.waitForTimeout(150);
await page.fill(`.ws-group[data-group-id="${childId}"] .ws-group-name .inline-edit`, "child");
await page
  .locator(`.ws-group[data-group-id="${childId}"] .ws-group-name .inline-edit`)
  .press("Enter");
await page.waitForTimeout(200);

// 子階層でも同じ操作ができる
await childHead.click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "セッションを作成" }).click();
await page.waitForTimeout(400);
const childMemberNames = await page
  .locator(`.ws-group[data-group-id="${childId}"] + .ws-group-members > .ws-item .ws-name`)
  .allTextContents();
const childSessionName = (await page.locator(".ws-item.is-active .ws-name").textContent()) ?? "";
check("session can be created in a nested group",
  /^Session \d+$/.test(childSessionName) && childMemberNames.includes(childSessionName),
  `name="${childSessionName}" members=${JSON.stringify(childMemberNames)}`);
await page.waitForFunction((name) => {
  const raw = window.__savedSession;
  if (!raw) return false;
  const saved = JSON.parse(raw);
  const parent = saved.groups?.find((g) => g.name === "fresh");
  const child = saved.groups?.find((g) => g.name === "child");
  const session = saved.workspaces?.find((w) => w.name === name);
  return saved.version === 5 && !!parent && child?.parentId === parent.id && session?.group === child.id;
}, childSessionName, { timeout: 8000 }).catch(() => {});
const nestedSaved = JSON.parse(await page.evaluate(() => window.__savedSession));
const nestedParentSaved = nestedSaved.groups.find((g) => g.name === "fresh");
const nestedChildSaved = nestedSaved.groups.find((g) => g.name === "child");
check("nested group relationship is persisted in v5",
  nestedChildSaved?.parentId === nestedParentSaved?.id &&
    nestedSaved.workspaces.find((w) => w.name === childSessionName)?.group === nestedChildSaved?.id);

// 親グループの全閉じで子階層もまとめて片付く
await freshHead.click({ button: "right" });
await page.locator("#ctx-menu button", { hasText: "グループごと全セッションを閉じる" }).click();
await page.waitForTimeout(500);
const namesAfterCloseAll = await page.locator(".ws-item .ws-name").allTextContents();
check("close-all removes nested groups and their sessions",
  (await page.locator(".ws-group-name", { hasText: /fresh|child/ }).count()) === 0 &&
    !namesAfterCloseAll.includes(freshSessionName) &&
    !namesAfterCloseAll.includes(childSessionName),
  `left=${JSON.stringify(namesAfterCloseAll)}`);

// --- 23a3. Whole とサイドバー余白の右クリックにも両方の新規作成を表示 ---
// Whole の作成先は active セッションの所属に引かれず、常にトップレベルになる。
await page.locator(".ws-item", { hasText: "api" }).locator(".ws-name").click();
await page.waitForTimeout(200);
const wholeGroup = page.locator(".ws-whole-group");
const wholeCreate = wholeGroup.locator(".ws-whole-head .ws-group-create");
check("top-level entries are enclosed by Whole",
  await wholeGroup.isVisible() && (await wholeCreate.count()) === 1);
await wholeCreate.click();
await page.waitForTimeout(100);
const defaultCtxLabels = await page.locator("#ctx-menu button").allTextContents();
check("Whole exposes both creation actions by left click",
  defaultCtxLabels.some((label) => label.startsWith("セッションを作成")) &&
    defaultCtxLabels.includes("グループを作成"));
const itemsBeforeDefaultSession = await page.locator(".ws-item").count();
await page.locator("#ctx-menu button", { hasText: "セッションを作成" }).click();
await page.waitForTimeout(400);
const defaultSessionName = (await page.locator(".ws-item.is-active .ws-name").textContent()) ?? "";
const defaultRootNames = await page
  .locator(".ws-whole-members > .ws-item .ws-name")
  .allTextContents();
check("Whole creates a session at the top of the root level",
  /^Session \d+$/.test(defaultSessionName) &&
    defaultRootNames[0] === defaultSessionName &&
    (await page.locator(".ws-item").count()) === itemsBeforeDefaultSession + 1,
  `name=${defaultSessionName} root=${JSON.stringify(defaultRootNames)}`);
const defaultSessionItem = page.locator(".ws-item", { hasText: defaultSessionName });
await defaultSessionItem.hover();
await defaultSessionItem.locator(".ws-close").click();
await page.waitForTimeout(300);

// グループ作成も同じく、Whole から切れば active のグループではなくトップレベル先頭へ置く。
await page.locator(".ws-item", { hasText: "api" }).locator(".ws-name").click();
await page.waitForTimeout(100);
await wholeCreate.click();
await page.waitForTimeout(100);
await page.locator("#ctx-menu button", { hasText: "グループを作成" }).click();
await page.waitForTimeout(250);
const wholeCreatedGroup = page.locator(".ws-whole-members > .ws-group").first();
const wholeCreatedGroupName = await wholeCreatedGroup.locator(".ws-group-name").textContent();
const wholeCreatedGroupMembers = await wholeCreatedGroup
  .locator("xpath=following-sibling::div[1]")
  .locator("> .ws-item")
  .count();
check("Whole creates a group at the top of the root level",
  /^Group \d+$/.test(wholeCreatedGroupName ?? "") &&
    wholeCreatedGroupMembers === 0,
  `name="${wholeCreatedGroupName}" members=${wholeCreatedGroupMembers}`);
await wholeCreatedGroup.click({ button: "right" });
await page.waitForTimeout(100);
await page.locator("#ctx-menu button", { hasText: "グループを解散" }).click();
await page.waitForTimeout(200);

const listBox = await page.locator("#ws-list").boundingBox();
await page.mouse.click(listBox.x + listBox.width / 2, listBox.y + listBox.height - 6, { button: "right" });
await page.waitForTimeout(150);
check("blank sidebar right-click offers create-group", await page.locator("#ctx-menu").isVisible());
const blankCtxLabels = await page.locator("#ctx-menu button").allTextContents();
check("blank sidebar offers both creation actions",
  blankCtxLabels.some((label) => label.startsWith("セッションを作成")) &&
    blankCtxLabels.includes("グループを作成"));
await page.locator("#ctx-menu button", { hasText: "グループを作成" }).click();
await page.waitForTimeout(250);
const rootNewHead = page.locator(".ws-whole-members > .ws-group").last();
const rootNewLabel = await rootNewHead.locator(".ws-group-name").textContent();
const rootNewMembers = await rootNewHead
  .locator("xpath=following-sibling::div[1]")
  .locator("> .ws-item")
  .count();
check("blank-area creates a new empty root group silently",
  !(await page.locator("#ws-new-form").isVisible()) &&
    /^Group \d+$/.test(rootNewLabel ?? "") && rootNewMembers === 0,
  `name="${rootNewLabel}" members=${rootNewMembers}`);
await rootNewHead.click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "グループを解散" }).click();
await page.waitForTimeout(200);

// 余白メニューのセッション作成もフォームを出さず、表示中セッションの直後へ即時作成する
await page.locator(".ws-item", { hasText: "Session 1" }).locator(".ws-name").click();
await page.waitForTimeout(100);
const itemsBeforeBlankSession = await page.locator(".ws-item").count();
await page.mouse.click(listBox.x + listBox.width / 2, listBox.y + listBox.height - 6, { button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "セッションを作成" }).click();
await page.waitForTimeout(400);
const blankSessionName = (await page.locator(".ws-item.is-active .ws-name").textContent()) ?? "";
const rootItemNames = await page.locator(".ws-whole-members > .ws-item .ws-name").allTextContents();
const blankSessionIndex = rootItemNames.indexOf(blankSessionName);
const session1Index = rootItemNames.indexOf("Session 1");
check("blank-area create-session makes an auto-named sibling without a form",
  !(await page.locator("#ws-new-form").isVisible()) &&
    /^Session \d+$/.test(blankSessionName) &&
    blankSessionIndex === session1Index + 1 &&
    (await page.locator(".ws-item").count()) === itemsBeforeBlankSession + 1,
  `name="${blankSessionName}" root=${JSON.stringify(rootItemNames)}`);
const blankItem = page.locator(".ws-item", { hasText: blankSessionName });
await blankItem.hover();
await blankItem.locator(".ws-close").click();
await page.waitForTimeout(300);

// --- 23b. 右クリックメニューからセッション複製（ペイン1つ・同じ cwd・直後に並ぶ） ---
// OSC 7 側は /home/user のまま、Rust の pty_cwd だけ現在地を変えて実 cwd 優先を検証する
await page.evaluate(() => { window.__mockPtyCwd = "/home/user/live-project"; });
await page.locator(".ws-item", { hasText: "Session 1" }).click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "セッションをコピー" }).click();
await page.waitForTimeout(400);
// 複製直後はリネームを開かず、そのまま打てるようターミナルにフォーカスが載る
const dupEditors = await page.locator(".ws-item .inline-edit").count();
check("duplicate does not open the name editor", dupEditors === 0, `editors=${dupEditors}`);
const dupFocus = await page.evaluate(() => document.activeElement?.className || "");
check("duplicate focuses the new terminal", dupFocus.includes("xterm-helper-textarea"),
  `activeElement="${dupFocus}"`);
const dupActive = await page.locator(".ws-item.is-active .ws-name").textContent();
const dupPanes = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const dupSpawn = await page.evaluate(() => window.__ptySpawns.at(-1));
check("duplicate creates active single-pane copy",
  dupActive === "Session 1のコピー" && dupPanes === 1,
  `active="${dupActive}" panes=${dupPanes}`);
check("duplicate opens in source pane's live cwd", dupSpawn.cwd === "/home/user/live-project",
  `cwd="${dupSpawn.cwd}"`);
const namesAfterDup = await page.locator(".ws-name").allTextContents();
check("duplicate placed right after source",
  namesAfterDup.indexOf("Session 1のコピー") === namesAfterDup.indexOf("Session 1") + 1,
  `names=${JSON.stringify(namesAfterDup)}`);
// 後続テストのセッション並び・⌘数字の番号に影響しないよう複製は閉じておく
await page.locator(".ws-item", { hasText: "のコピー" }).hover(); // × はホバー中のみ表示
await page.locator(".ws-item", { hasText: "のコピー" }).locator(".ws-close").click();
await page.waitForTimeout(300);
const dupGone = await page.locator(".ws-item", { hasText: "のコピー" }).count();
check("duplicated session closes cleanly", dupGone === 0, `remaining=${dupGone}`);
await page.evaluate(() => { window.__mockPtyCwd = null; });

// --- 23b2. 複製直後の打鍵はコピー先のターミナルへ流れる ---
await page.locator(".ws-item", { hasText: "Session 1" }).click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "セッションをコピー" }).click();
await page.waitForTimeout(400);
const dupPaneId = await page.evaluate(() => window.__ptySpawns.at(-1).id);
const dupTypeBefore = await page.evaluate(() => window.__ptyWrites.length);
await page.keyboard.type("ls");
await page.waitForTimeout(200);
const dupTyped = await page.evaluate(
  (n) => window.__ptyWrites.slice(n), dupTypeBefore);
check("typing right after duplicate goes to the copied terminal",
  dupTyped.map((x) => x.data).join("") === "ls" && dupTyped.every((x) => x.id === dupPaneId),
  `writes=${JSON.stringify(dupTyped)} pane=${dupPaneId}`);
await page.locator(".ws-item", { hasText: "のコピー" }).hover();
await page.locator(".ws-item", { hasText: "のコピー" }).locator(".ws-close").click();
await page.waitForTimeout(300);

// --- 23b3. 連続複製は「のコピー」を重ねず連番になる ---
const duplicateSession = async (name) => {
  await page.locator(".ws-item", { hasText: name }).first().click({ button: "right" });
  await page.waitForTimeout(150);
  await page.locator("#ctx-menu button", { hasText: "セッションをコピー" }).click();
  await page.waitForTimeout(400);
  return (await page.locator(".ws-item.is-active .ws-name").textContent()) ?? "";
};
const dupSeq = [];
for (let i = 0; i < 3; i++) dupSeq.push(await duplicateSession("Session 1"));
check("repeated duplicates get numbered instead of stacking 「のコピー」",
  JSON.stringify(dupSeq) ===
    JSON.stringify(["Session 1のコピー", "Session 1のコピー 2", "Session 1のコピー 3"]),
  `names=${JSON.stringify(dupSeq)}`);
// コピーをさらに複製しても「のコピーのコピー」にはせず、元名の空き番号を使う
const dupOfDup = await duplicateSession("Session 1のコピー 2");
check("duplicating a copy reuses the source name with the next number",
  dupOfDup === "Session 1のコピー 4", `name="${dupOfDup}"`);
// 後続テストの並び・⌘数字に影響しないよう、コピーは残らず閉じる
for (let i = 0; i < dupSeq.length + 1; i++) {
  const item = page.locator(".ws-item", { hasText: "のコピー" }).first();
  await item.hover(); // × はホバー中のみ表示
  await item.locator(".ws-close").click();
  await page.waitForTimeout(250);
}
const dupSeqGone = await page.locator(".ws-item", { hasText: "のコピー" }).count();
check("numbered duplicates close cleanly", dupSeqGone === 0, `remaining=${dupSeqGone}`);

// --- 23b4. メニューの数量ステッパーで一度に複数コピー ---
await page.locator(".ws-item", { hasText: "Session 1" }).first().click({ button: "right" });
await page.waitForTimeout(150);
const dupBtn = page.locator("#ctx-menu button", { hasText: "セッションを" }).first();
const stepLess = page.locator("#ctx-menu .ctx-count-btn").first();
const stepMore = page.locator("#ctx-menu .ctx-count-btn").last();
check("copy count starts at 1 with the minus button disabled",
  (await page.locator("#ctx-menu .ctx-count-value").textContent()) === "1" &&
    (await stepLess.isDisabled()),
  `value="${await page.locator("#ctx-menu .ctx-count-value").textContent()}"`);
await stepMore.click();
await stepMore.click(); // 1 → 3
const dupCountValue = await page.locator("#ctx-menu .ctx-count-value").textContent();
const dupCountLabel = await dupBtn.textContent();
check("stepper updates the count and the copy button label",
  dupCountValue === "3" && dupCountLabel === "セッションを3個コピー",
  `value="${dupCountValue}" label="${dupCountLabel}"`);
await stepLess.click(); // 3 → 2 も効く
await stepMore.click();
const spawnsBeforeMulti = await page.evaluate(() => window.__ptySpawns.length);
await dupBtn.click();
await page.waitForTimeout(900);
const multiNames = await page.locator(".ws-name").allTextContents();
const multiCopies = multiNames.filter((n) => n.startsWith("Session 1のコピー"));
const multiSpawned = await page.evaluate(
  (n) => window.__ptySpawns.length - n, spawnsBeforeMulti);
check("stepper copy creates the requested number of sessions",
  multiCopies.length === 3 && multiSpawned === 3,
  `copies=${JSON.stringify(multiCopies)} spawns=${multiSpawned}`);
const srcIdx = multiNames.indexOf("Session 1");
check("multi copies are placed right after the source in order",
  JSON.stringify(multiNames.slice(srcIdx + 1, srcIdx + 4)) ===
    JSON.stringify(["Session 1のコピー", "Session 1のコピー 2", "Session 1のコピー 3"]),
  `names=${JSON.stringify(multiNames)}`);
const multiActive = await page.locator(".ws-item.is-active .ws-name").textContent();
const multiPanes = await page.locator(".workspace-layer:not([hidden]) .pane").count();
const multiFocus = await page.evaluate(() => document.activeElement?.className || "");
check("last copy becomes the active single-pane session with focus",
  multiActive === "Session 1のコピー 3" && multiPanes === 1 &&
    multiFocus.includes("xterm-helper-textarea"),
  `active="${multiActive}" panes=${multiPanes} focus="${multiFocus}"`);
// 後続テストの並び・⌘数字に影響しないよう、コピーは残らず閉じる
for (let i = 0; i < 3; i++) {
  const item = page.locator(".ws-item", { hasText: "のコピー" }).first();
  await item.hover(); // × はホバー中のみ表示
  await item.locator(".ws-close").click();
  await page.waitForTimeout(250);
}
const multiGone = await page.locator(".ws-item", { hasText: "のコピー" }).count();
check("multi copies close cleanly", multiGone === 0, `remaining=${multiGone}`);

// --- 23c. 右クリックメニューから名前を変更（インライン編集が始まる） ---
await page.locator(".ws-item", { hasText: "Session 1" }).click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "名前を変更" }).click();
await page.waitForTimeout(150);
const ctxRenEdit = await page.locator(".ws-item .inline-edit").count();
check("context menu rename starts inline edit", ctxRenEdit === 1, `edits=${ctxRenEdit}`);
await page.locator(".ws-item .inline-edit").fill("CtxRenamed");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const ctxRenName = await page.locator(".ws-item", { hasText: "CtxRenamed" }).count();
check("context menu rename applies", ctxRenName === 1, `items=${ctxRenName}`);
// 後続テストは "Session 1" 前提なので元に戻す
await page.locator(".ws-item", { hasText: "CtxRenamed" }).click({ button: "right" });
await page.waitForTimeout(150);
await page.locator("#ctx-menu button", { hasText: "名前を変更" }).click();
await page.waitForTimeout(150);
await page.locator(".ws-item .inline-edit").fill("Session 1");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);

// --- 24. グループ名変更が所属全セッションに一括反映 ---
await page.locator(".ws-group-name", { hasText: "work" }).dblclick();
await page.waitForTimeout(150);
await page.locator(".ws-group .inline-edit").fill("team");
await page.keyboard.press("Enter");
await page.waitForFunction(() => {
  const s = window.__savedSession;
  if (!s) return false;
  const saved = JSON.parse(s);
  const group = saved.groups?.find((g) => g.name === "team");
  return !!group && saved.workspaces.filter((w) => w.group === group.id).length === 2;
}, undefined, { timeout: 8000 }).catch(() => {});
const renamedGroup = await page.locator(".ws-group-name").first().textContent();
const savedTeam = JSON.parse(await page.evaluate(() => window.__savedSession));
const savedTeamGroup = savedTeam.groups.find((g) => g.name === "team");
const teamMembers = savedTeam.workspaces.filter((w) => w.group === savedTeamGroup?.id).length;
check("group rename applies to all members", renamedGroup === "team" && teamMembers === 2,
  `header="${renamedGroup}" members=${teamMembers}`);

// --- 25. 検索がグループ名でもヒット ---
await page.fill("#ws-search", "tea");
await page.waitForTimeout(200);
const groupHitItems = await page.locator(".ws-item").count();
check("search matches group name", groupHitItems === 2, `items=${groupHitItems}`);
await page.fill("#ws-search", "");
await page.waitForTimeout(200);

}
