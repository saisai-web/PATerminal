// ============================================================
// セッション保存 / 復元
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import {
  isAgentPanelCollapsed,
  setAgentPanelCollapsed,
} from "../features/git/agent-panel";
import { MAX_RATIO, MIN_RATIO, PRESETS } from "../shared/constants";
import {
  getExplorerFavorites,
  renderExplorerFavs,
  setExplorerFavorites,
} from "../features/explorer/explorer";
import { groupById, newGroupId } from "../workspace/groups";
import { applyStaticTexts, defaultLang, getLang, isLang, setLang, t } from "../i18n";
import { makePane } from "../terminal/pane";
import {
  getQuickPhrases,
  isQuickPhraseBarCollapsed,
  setQuickPhraseBarCollapsed,
  setQuickPhrases,
} from "../features/quick-phrases/quick-phrases";
import {
  getTheme,
  isAutoEnterAllEnabled,
  isNotificationsEnabled,
  setAutoEnterAllEnabled,
  setNotificationsEnabled,
  setTheme,
} from "../features/settings/settings-panel";
import {
  collapsedGroups,
  getActiveWs,
  groups,
  setHostOs,
  workspaces,
} from "../workspace/state";
import { themeById } from "../features/settings/themes";
import { refreshLicenseStatus } from "../features/license/license";
import { renderLockMarks } from "../features/license/lock-marks";
import { buildTree } from "../terminal/tree";
import type { TreeNode } from "../terminal/tree";
import type {
  DeletedWorkspace,
  SerializedNode,
  SerializedWorkspace,
  SessionV1,
  SessionV3,
  SessionV4,
  SessionV5,
  Workspace,
} from "../workspace/types";
import { normalizeWorkspaceBackgroundColor } from "../workspace/types";
import { getRecentDirs, setRecentDirs } from "../features/sidebar/recent-dirs";
import { getWorktreePrefs, setWorktreePrefs } from "../features/git/worktree";
import { getPairDefaultCmds, setPairDefaultCmds } from "../features/pair/pair";
import { createEmptyWorkspace, setActive } from "../workspace/workspace";
import { normalizeWorkspaceNote } from "../workspace/note";
import {
  addDeletedWorkspace,
  getDeletedWorkspaces,
  setDeletedWorkspaces,
} from "../features/sidebar/session-trash";

const saveStateEl = document.querySelector<HTMLSpanElement>("#save-state")!;

let saveTimer: number | undefined;
let saving = false;
let resaveQueued = false;

/** ブラウザのアイドル時間まで待つ。打鍵や描画を優先させるための譲歩ポイント */
function idleSlice(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 500 });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}

function serialize(node: TreeNode): SerializedNode {
  if (node.kind === "leaf") {
    const { spec, cwd } = node.pane;
    return {
      kind: "leaf",
      title: spec.title,
      // resume 指定がある直接起動ペインでは初回 argv を再実行・保存せず、
      // 再開専用のコマンドだけを session.json に残す
      shell: spec.resumeShell ? undefined : spec.shell,
      args: spec.resumeArgs ? undefined : spec.args,
      resumeShell: spec.resumeShell,
      resumeArgs: spec.resumeArgs,
      run: spec.run,
      resumeRun: spec.resumeRun,
      // 実行中に検知したエージェント（features/agents/watch.ts が維持）。
      // 復元時はここから claude --resume <id> 等の再開コマンドを組み立てる
      agent: spec.agent,
      cwd: cwd ?? spec.cwd,
      scrollback: node.pane.snapshot(),
    };
  }
  return { kind: "split", dir: node.dir, ratio: node.ratio, a: serialize(node.a), b: serialize(node.b) };
}

function serializeWorkspace(ws: Workspace): SerializedWorkspace | null {
  if (!ws.root) return null;
  return {
    id: ws.id,
    name: ws.name,
    note: ws.note,
    pinned: ws.pinned || undefined,
    archived: ws.archived || undefined,
    lastOpAt: ws.lastOpAt,
    backgroundColor: ws.backgroundColor,
    group: ws.group,
    sidebarOrder: ws.sidebarOrder,
    shellKind: ws.shellKind,
    broadcast: ws.broadcast,
    autoEnter: ws.autoEnter || undefined,
    root: serialize(ws.root),
  };
}

function serializeAll(): SessionV5 {
  return {
    version: 5,
    activeId: getActiveWs()?.id ?? "",
    collapsedGroups: [...collapsedGroups],
    groups: groups.map((group) => ({ ...group })),
    explorer: { favorites: getExplorerFavorites() },
    settings: {
      theme: getTheme(),
      language: getLang(),
      notifications: isNotificationsEnabled(),
      autoEnter: isAutoEnterAllEnabled() || undefined,
      quickPhrases: getQuickPhrases(),
      collapsed: {
        changes: isAgentPanelCollapsed(),
        quickPhrases: isQuickPhraseBarCollapsed(),
        oneLine: true,
      },
      recentDirs: getRecentDirs(),
      worktree: getWorktreePrefs(),
      pair: getPairDefaultCmds(),
    },
    workspaces: workspaces.map(serializeWorkspace).filter((w): w is SerializedWorkspace => !!w),
    deletedWorkspaces: getDeletedWorkspaces(),
  };
}

/** 削除直前のセッションを履歴へ退避する。SerializeAddon は同期で重いため、
    通常保存と同じく1ペインずつアイドルスライスを挟んで最新キャッシュへ更新する。 */
export async function archiveWorkspace(ws: Workspace, originalIndex: number): Promise<void> {
  if (!ws.root) return;
  for (const pane of [...ws.panes.values()]) {
    await idleSlice();
    pane.refreshSnapshot();
  }
  const saved = serializeWorkspace(ws);
  if (saved) {
    addDeletedWorkspace({ ...saved, deletedAt: Date.now(), originalIndex });
  }
}

export function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), 800);
}

async function saveNow(): Promise<boolean> {
  if (!workspaces.some((w) => w.root)) return true;
  if (saving) {
    // 実行中なら完了後にもう一度（連打で多重シリアライズしない）
    resaveQueued = true;
    return false;
  }
  saving = true;
  try {
    // 重いスナップショット採取は1ペインずつアイドル時間に行う。
    // 全ペイン一括の同期シリアライズは打鍵中に100ms級のブロックを作り、
    // キー入力の取りこぼしの原因になる。
    for (const ws of [...workspaces]) {
      for (const pane of [...ws.panes.values()]) {
        await idleSlice();
        pane.refreshSnapshot();
      }
    }
    await invoke("session_save", { data: JSON.stringify(serializeAll(), null, 2) });
    saveStateEl.textContent = "";
    return true;
  } catch {
    saveStateEl.textContent = t("save.failed");
    return false;
  } finally {
    saving = false;
    if (resaveQueued) {
      resaveQueued = false;
      scheduleSave();
    }
  }
}

/** updater が終了する直前に、debounce 中の状態も含めて session.json へ確定する。 */
export async function flushSessionSave(): Promise<boolean> {
  window.clearTimeout(saveTimer);
  while (saving) await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  return saveNow();
}

function restoreTree(ws: Workspace, node: SerializedNode): TreeNode {
  if (node.kind === "leaf") {
    const { kind: _kind, scrollback, ...spec } = node;
    return { kind: "leaf", pane: makePane(ws, spec, { scrollback, resumed: true }) };
  }
  return {
    kind: "split",
    dir: node.dir,
    ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, node.ratio)),
    a: restoreTree(ws, node.a),
    b: restoreTree(ws, node.b),
  };
}

/** 「最近削除したセッション」から、ペイン構成・表示履歴・再開情報をまとめて戻す。 */
export function restoreDeletedWorkspace(saved: DeletedWorkspace): boolean {
  try {
    // 通常は元IDを再利用する。手編集した保存データ等で衝突していれば新しいIDへ退避する
    const id = workspaces.some((w) => w.id === saved.id) ? undefined : saved.id;
    const ws = createEmptyWorkspace(id, saved.name, saved.shellKind, saved.broadcast, saved.autoEnter === true);
    ws.note = normalizeWorkspaceNote(saved.note);
    ws.pinned = saved.pinned === true || undefined;
    ws.archived = saved.archived === true || undefined;
    ws.backgroundColor = normalizeWorkspaceBackgroundColor(saved.backgroundColor);
    ws.group = groupById(saved.group) ? saved.group : undefined;
    ws.sidebarOrder = Number.isFinite(saved.sidebarOrder) ? saved.sidebarOrder : undefined;
    ws.root = restoreTree(ws, saved.root);

    // createEmptyWorkspace は末尾へ追加するため、元位置のヒントが有効なら差し戻す
    const from = workspaces.indexOf(ws);
    const to = Math.min(
      Math.max(0, Number.isInteger(saved.originalIndex) ? saved.originalIndex! : from),
      Math.max(0, workspaces.length - 1),
    );
    if (from >= 0 && to !== from) {
      workspaces.splice(from, 1);
      workspaces.splice(to, 0, ws);
    }
    setActive(ws);
    scheduleSave();
    return true;
  } catch {
    return false;
  }
}

/** host_os が取れないときの推定。ここを取り違えるとルート表記・パスの引用・
    ショートカットが同時に狂うので、macOS 固定にはしない */
function guessHostOs(): string {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macos";
  return "linux";
}

export async function boot() {
  // host_os が未実装の古いバイナリでも起動は継続する。
  // ライセンス状態は復元（ペイン構築）と静的文言の刻印より前に確定させる
  // （失敗時は license.ts の初期値 = unlocked のまま進む fail-open）
  const [hostOs] = await Promise.all([
    invoke<string>("host_os").catch(guessHostOs),
    refreshLicenseStatus(),
  ]);
  setHostOs(hostOs);

  let raw: string | null = null;
  try {
    raw = await invoke<string | null>("session_load");
  } catch {
    /* 読めなければ新規 */
  }

  // テーマ・言語はペイン構築（restoreTree）より前に適用する。
  // ペインの xterm テーマは構築時に決まるため、後から当てるとフラッシュする
  let parsedRaw: unknown = null;
  if (raw) {
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      /* 壊れたファイルはデフォルト起動 */
    }
  }
  const savedSettings = (parsedRaw as SessionV3 | null)?.settings;
  setTheme(themeById(savedSettings?.theme).id); // 不正値・未設定は dark
  setLang(isLang(savedSettings?.language) ? savedSettings.language : defaultLang()); // 未対応・未設定は OS 設定から
  // 帯の開閉は定型文の復元（= バーの描画）より先に決める。
  // oneLine マーカーが無い旧保存データは、以前の既定 false と明示展開を区別できないため
  // 初回だけ1行表示へ移行する。以後はユーザーが展開して保存した false もそのまま尊重する。
  const oneLineBars = savedSettings?.collapsed?.oneLine === true;
  setAgentPanelCollapsed(oneLineBars ? savedSettings?.collapsed?.changes !== false : true);
  setQuickPhraseBarCollapsed(oneLineBars ? savedSettings?.collapsed?.quickPhrases !== false : true);
  setQuickPhrases(savedSettings?.quickPhrases);
  setRecentDirs(savedSettings?.recentDirs);
  setWorktreePrefs(savedSettings?.worktree);
  setPairDefaultCmds(savedSettings?.pair);
  applyStaticTexts();
  renderLockMarks(); // applyStaticTexts の後（🔒 は .is-locked クラス + CSS 疑似要素）
  setNotificationsEnabled(savedSettings?.notifications !== false); // 未設定はデフォルト ON
  setAutoEnterAllEnabled(savedSettings?.autoEnter === true); // 旧全体設定も全セッションモードとして復元

  if (parsedRaw) {
    try {
      const parsed = parsedRaw as any;
      if (parsed.version === 5 || parsed.version === 4) {
        const v4 = parsed as SessionV4;
        setDeletedWorkspaces(
          parsed.version === 5 ? (parsed as SessionV5).deletedWorkspaces : [],
        );
        // 不正なID・重複・循環した親参照はルートへ退避し、保存データ全体を巻き込ませない
        for (const saved of v4.groups ?? []) {
          if (
            typeof saved.id === "string" &&
            saved.id &&
            typeof saved.name === "string" &&
            saved.name &&
            !groups.some((group) => group.id === saved.id)
          ) {
            groups.push({
              id: saved.id,
              name: saved.name,
              parentId: saved.parentId,
              sidebarOrder: Number.isFinite(saved.sidebarOrder) ? saved.sidebarOrder : undefined,
            });
          }
        }
        const validIds = new Set(groups.map((group) => group.id));
        for (const group of groups) {
          if (!group.parentId || !validIds.has(group.parentId) || group.parentId === group.id) {
            group.parentId = undefined;
            continue;
          }
          const seen = new Set([group.id]);
          let parent = groupById(group.parentId);
          while (parent && !seen.has(parent.id)) {
            seen.add(parent.id);
            parent = groupById(parent.parentId);
          }
          if (parent) group.parentId = undefined;
        }
        for (const s of v4.workspaces) {
          const ws = createEmptyWorkspace(s.id, s.name, s.shellKind, s.broadcast, s.autoEnter === true);
          ws.note = normalizeWorkspaceNote(s.note);
          ws.pinned = s.pinned === true || undefined;
          ws.archived = s.archived === true || undefined;
          ws.lastOpAt = Number.isFinite(s.lastOpAt) ? s.lastOpAt : undefined;
          ws.backgroundColor = normalizeWorkspaceBackgroundColor(s.backgroundColor);
          ws.group = validIds.has(s.group ?? "") ? s.group : undefined;
          ws.sidebarOrder = Number.isFinite(s.sidebarOrder) ? s.sidebarOrder : undefined;
          ws.root = restoreTree(ws, s.root);
        }
        for (const id of v4.collapsedGroups ?? []) {
          if (validIds.has(id)) collapsedGroups.add(id);
        }
        setExplorerFavorites((v4.explorer?.favorites ?? []).filter((p) => typeof p === "string"));
        renderExplorerFavs();
        // 表示タブは起動ごとに「すべて」へ戻る。前回アーカイブタブで終了していても、
        // 通常セッションがあるならそれを開き、表示中の端末だけ一覧から消えた状態にしない。
        const savedTarget = workspaces.find((w) => w.id === v4.activeId);
        const target =
          (savedTarget?.archived ? undefined : savedTarget) ??
          workspaces.find((w) => !w.archived) ??
          savedTarget ??
          workspaces[0];
        if (target) {
          setActive(target);
          if (parsed.version === 4) scheduleSave(); // 次回から v5 で保存する
          return;
        }
      } else if (parsed.version === 3 || parsed.version === 2) {
        // v2 は group / collapsedGroups / explorer が無いだけの同形。
        // v3 のグループ名を安定IDへ変換し、次回保存から v4 にする
        const v3 = parsed as SessionV3;
        const legacyGroupIds = new Map<string, string>();
        for (const s of v3.workspaces) {
          if (typeof s.group !== "string" || !s.group || legacyGroupIds.has(s.group)) continue;
          const id = newGroupId();
          legacyGroupIds.set(s.group, id);
          groups.push({ id, name: s.group });
        }
        for (const s of v3.workspaces) {
          const ws = createEmptyWorkspace(s.id, s.name, s.shellKind, s.broadcast, s.autoEnter === true);
          ws.note = normalizeWorkspaceNote(s.note);
          ws.group = typeof s.group === "string" ? legacyGroupIds.get(s.group) : undefined;
          ws.root = restoreTree(ws, s.root);
        }
        for (const name of v3.collapsedGroups ?? []) {
          const id = legacyGroupIds.get(name);
          if (id) collapsedGroups.add(id);
        }
        // エクスプローラーの開閉・隠しファイルは常にデフォルト（表示 + ON）で開くため
        // 復元しない。お気に入りだけは永続データなので復元する
        setExplorerFavorites((v3.explorer?.favorites ?? []).filter((p) => typeof p === "string"));
        renderExplorerFavs();
        const target = workspaces.find((w) => w.id === v3.activeId) ?? workspaces[0];
        if (target) {
          setActive(target);
          scheduleSave(); // 次回から v4 で保存される
          return;
        }
      } else if (parsed.version === 1 && parsed.root) {
        // v1 → 単一セッションとしてマイグレーション
        const v1 = parsed as SessionV1;
        const ws = createEmptyWorkspace(undefined, "Session 1", "default", !!v1.broadcast);
        ws.root = restoreTree(ws, v1.root);
        setActive(ws);
        scheduleSave(); // 次回から v4 で保存される
        return;
      }
    } catch {
      /* 壊れたファイルはデフォルト起動 */
    }
  }

  // 初回起動: まずは1ペイン。必要な分だけツールバーから分割してもらう
  const ws = createEmptyWorkspace(undefined, "Session 1", "default", false);
  ws.root = buildTree(ws, PRESETS["shell x1"]);
  setActive(ws);
}

// スクロールバックは常時変化するので、レイアウト変更起点の保存に加えて30秒ごとに定期保存する
window.setInterval(() => scheduleSave(), 30_000);
