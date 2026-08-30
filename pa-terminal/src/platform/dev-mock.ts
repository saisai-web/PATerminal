// ブラウザ単体テスト用の Tauri IPC モック（ui-test.mjs から利用）。
// 実アプリ（Tauri WebView）では __TAURI_INTERNALS__ が既に在るため何もしない。
// 使い方: `npm run dev` でサーバーを立て、`node ui-test.mjs` を実行する。

type Cb = (e: unknown) => void;

const w = window as unknown as Record<string, unknown>;

if (!w.__TAURI_INTERNALS__) {
  let nextId = 1;
  const cbs = new Map<number, Cb>();
  const listeners = new Map<string, Map<number, Cb>>();
  const writes: { id: string; data: string }[] = [];
  w.__ptyWrites = writes;
  const spawns: {
    id: string;
    shell: string | null;
    args: string[] | null;
    cwd: string | null;
    cols: number;
    rows: number;
  }[] = [];
  w.__ptySpawns = spawns;
  // PTY のサイズ同期の検証用（ui-tests/31-resize.mjs）
  const resizes: { id: string; cols: number; rows: number; t: number }[] = [];
  w.__ptyResizes = resizes;
  const visibles: { ids: string[]; visible: boolean; t: number }[] = [];
  w.__ptyVisible = visibles;
  /** pty_* の呼び出し順。resize と set_visible の前後関係を見るのに使う */
  const ipcLog: { cmd: string; id: string; t: number }[] = [];
  w.__ipcLog = ipcLog;

  // fs_list 用のモックファイルツリー（読み取り専用エクスプローラーのテスト用）
  const mockFsTree: Record<string, { name: string; isDir: boolean }[]> = {
    "/": [
      { name: "home", isDir: true },
      { name: "forbidden", isDir: true }, // 開くと permission エラーを返す
      { name: "tmp", isDir: true },
      { name: "root.txt", isDir: false },
    ],
    "/home": [{ name: "user", isDir: true }],
    "/home/user": [
      { name: "proj", isDir: true },
      { name: ".config", isDir: true },
      { name: "big", isDir: true }, // 500件で打ち切られる巨大ディレクトリ
      { name: "readme.md", isDir: false },
      { name: ".hidden-file", isDir: false },
    ],
    "/home/user/proj": [
      { name: "src", isDir: true },
      { name: "main.ts", isDir: false },
    ],
    "/home/user/proj/src": [],
    "/tmp": [],
    "/tmp/pair-project": [],
  };
  // Windows を装うテストでは既定ルートが "C:/" になる（paths.ts の fsDefaultRoot）。
  // ドライブルート配下にも同じ形の枝を用意して、Windows 分岐を実際に踏めるようにする
  if (w.__mockHostOs === "windows") {
    Object.assign(mockFsTree, {
      "C:/": [
        { name: "Users", isDir: true },
        { name: "root.txt", isDir: false },
      ],
      "C:/Users": [{ name: "user", isDir: true }],
      "C:/Users/user": [
        { name: "proj", isDir: true },
        { name: "readme.md", isDir: false },
      ],
      "C:/Users/user/proj": [{ name: "main.ts", isDir: false }],
    });
  }
  w.__mockFsTree = mockFsTree;
  const fsCreatedDirs: string[] = [];
  w.__fsCreatedDirs = fsCreatedDirs;
  const fsTrashed: string[] = [];
  w.__fsTrashed = fsTrashed;
  const fsMoves: { src: string; destDir: string }[] = [];
  w.__fsMoves = fsMoves;
  const fsImports: { destDir: string; sources: string[] }[] = [];
  w.__fsImports = fsImports;
  const fsIsDirCalls: string[] = [];
  w.__fsIsDirCalls = fsIsDirCalls;
  // fs_read / fs_write 用のモックファイル内容（ファイルビューア / 編集のテスト用）
  const mockFsFiles: Record<string, string> = {
    "/root.txt": "root file\n",
    "/home/user/readme.md": "# readme\nhello\n",
    "/home/user/proj/main.ts": "console.log(1);\n",
  };
  w.__mockFsFiles = mockFsFiles;
  const fsWrites: { path: string; text: string }[] = [];
  w.__fsWrites = fsWrites;

  /** ペインID → PTY データ用 Channel（onmessage を直接叩いて配信する） */
  const channels = new Map<string, { onmessage: (data: string) => void }>();
  // テストから全ペインに PTY 出力を注入する（OSC 7 で cd を偽装する等）
  w.__ptyPushAll = (data: string) => {
    for (const ch of channels.values()) ch.onmessage(data);
  };

  const emit = (event: string, payload: unknown) => {
    const m = listeners.get(event);
    if (m) for (const cb of m.values()) cb({ event, id: 0, payload });
  };
  // テストから Rust 発イベント（pty:act / pty:bell / pty:exit 等）を注入する
  w.__emit = emit;

  // 通知プラグインのモック。sendNotification は invoke ではなく window.Notification を
  // 直接 new する（Tauri 実行時はプラグインの注入シムが受ける）ため、クラスごと
  // 差し替えて記録する。Playwright(Chromium) の実 Notification は権限で落ちる
  const notifications: { title: string; body?: string }[] = [];
  w.__notifications = notifications;
  class MockNotification {
    static permission = "granted";
    static requestPermission(): Promise<string> {
      return Promise.resolve("granted");
    }
    constructor(title: string, options?: { body?: string }) {
      notifications.push({ title, body: options?.body });
    }
  }
  (w as { Notification?: unknown }).Notification = MockNotification;


  // @tauri-apps/api の unlisten はこの internals 経由でリスナーを外す
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, eventId: number) {
      listeners.get(event)?.delete(eventId);
    },
  };

  w.__TAURI_INTERNALS__ = {
    transformCallback(cb: Cb): number {
      const id = nextId++;
      cbs.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      cbs.delete(id);
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
      switch (cmd) {
        case "plugin:event|listen": {
          const event = args.event as string;
          const handler = args.handler as number;
          const cb = cbs.get(handler);
          if (cb) {
            if (!listeners.has(event)) listeners.set(event, new Map());
            listeners.get(event)!.set(handler, cb);
          }
          return handler;
        }
        case "plugin:event|unlisten": {
          const event = args.event as string;
          const eventId = args.eventId as number;
          listeners.get(event)?.delete(eventId);
          return null;
        }
        case "host_os":
          return (w.__mockHostOs as string) ?? "macos";
        case "agent_signal_init":
          // ペアの完了フック注入用シグナルディレクトリ（実体は Rust が用意する）
          return "/mock/pair-signals";
        case "plugin:notification|is_permission_granted":
          return true;
        case "plugin:dialog|open": {
          const dialogOpts = args.options as { directory?: boolean; filters?: unknown[] } | undefined;
          // テストから開いたダイアログの条件を確認できるよう全種類を記録する。
          if (!Array.isArray(w.__dialogOpenCalls)) w.__dialogOpenCalls = [];
          (w.__dialogOpenCalls as unknown[]).push(dialogOpts);
          if (dialogOpts?.directory) {
            // フォルダ選択（履歴引き継ぎの「参照…」等）。テストから
            // window.__mockPickedDirectory（または null = キャンセル）を注入する
            return (w.__mockPickedDirectory as string | string[] | null) ?? null;
          }
          // フィルタ付きは画像選択、無しは Files パネルのファイルインポートとして別々に注入する。
          if (dialogOpts?.filters?.length) {
            return (w.__mockPickedImages as string[] | null) ?? null;
          }
          return (w.__mockPickedFiles as string[] | null) ?? null;
        }
        case "pty_spawn": {
          const id = args.id as string;
          spawns.push({
            id,
            shell: (args.shell as string | null) ?? null,
            args: (args.args as string[] | null) ?? null,
            cwd: (args.cwd as string | null) ?? null,
            // 初回リサイズの検証用。要素が DOM に入る前の spawn なので既定は 80x24
            cols: args.cols as number,
            rows: args.rows as number,
          });
          ipcLog.push({ cmd, id, t: performance.now() });
          // 保存済み shell / args の起動失敗から対話シェルへ退避する回帰テスト用。
          // 指定回数だけ Channel 登録前に実際の invoke と同じ reject を返す。
          const spawnFailLeft = (w.__mockPtySpawnFailUntil as number | undefined) ?? 0;
          if (spawnFailLeft > 0) {
            w.__mockPtySpawnFailUntil = spawnFailLeft - 1;
            throw new Error("mock pty_spawn failure");
          }
          const ch = args.onData as { onmessage: (data: string) => void } | undefined;
          if (ch) channels.set(id, ch);
          // 実シェル同様に OSC 7 で cwd を通知してからプロンプトを出す。
          // Windows の "C:/..." はホスト名扱いされないよう空ホスト（file:///）にする
          const defaultCwd = w.__mockHostOs === "windows" ? "C:/Users/user" : "/home/user";
          const cwd = (args.cwd as string | null) ?? defaultCwd;
          const url = cwd.startsWith("/") ? `file://${cwd}` : `file:///${cwd}`;
          setTimeout(() => channels.get(id)?.onmessage(`\x1b]7;${url}\x1b\\mock$ `), 30);
          return null;
        }
        case "pty_write": {
          const id = args.id as string;
          const data = args.data as string;
          writes.push({ id, data });
          channels.get(id)?.onmessage(data); // ローカルエコー
          return null;
        }
        case "pty_broadcast": {
          const ids = args.ids as string[];
          const data = args.data as string;
          for (const id of ids) {
            writes.push({ id, data });
            channels.get(id)?.onmessage(data);
          }
          return null;
        }
        case "pty_resize": {
          const id = args.id as string;
          const cols = args.cols as number;
          const rows = args.rows as number;
          ipcLog.push({ cmd, id, t: performance.now() });
          // リトライ経路の検証用。__mockPtyResizeFailUntil 回だけ失敗させる
          const failLeft = (w.__mockPtyResizeFailUntil as number | undefined) ?? 0;
          if (failLeft > 0) {
            w.__mockPtyResizeFailUntil = failLeft - 1;
            throw new Error("mock pty_resize failure");
          }
          resizes.push({ id, cols, rows, t: performance.now() });
          return null;
        }
        case "pty_set_visible": {
          const ids = args.ids as string[];
          const visible = args.visible as boolean;
          visibles.push({ ids, visible, t: performance.now() });
          for (const id of ids) ipcLog.push({ cmd, id, t: performance.now() });
          return null;
        }
        case "pty_kill": {
          channels.delete(args.id as string);
          ipcLog.push({ cmd, id: args.id as string, t: performance.now() });
          return null;
        }
        case "fs_list": {
          const path = args.path as string;
          if (path === "/forbidden") throw new Error("permission denied (mock)");
          if (path === "/home/user/big") {
            // 実装は 500 件で打ち切って truncated を立てる
            const entries = Array.from({ length: 500 }, (_, i) => ({
              name: `file-${String(i).padStart(4, "0")}.txt`,
              isDir: false,
            }));
            return { entries, truncated: true };
          }
          const raw = mockFsTree[path];
          if (!raw) throw new Error(`no such directory (mock): ${path}`);
          const entries = [...raw].sort(
            (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
          );
          return { entries, truncated: false };
        }
        case "fs_is_dir": {
          const path = args.path as string;
          fsIsDirCalls.push(path);
          if (path === "/forbidden") throw new Error("permission denied (mock)");
          if (!mockFsTree[path]) throw new Error(`no such directory (mock): ${path}`);
          return null;
        }
        case "fs_search": {
          // 実装（Rust）と同じく幅優先で配下を走査し、名前部分一致を返す
          const root = (args.path as string).replace(/\/+$/, "");
          const needle = (args.query as string).trim().toLowerCase();
          const includeHidden = args.includeHidden as boolean;
          if (!needle) return { matches: [], truncated: false };
          const matches: {
            path: string;
            name: string;
            isDir: boolean;
            parent: string;
            depth: number;
          }[] = [];
          const queue: { parent: string; depth: number }[] = [{ parent: root, depth: 1 }];
          while (queue.length) {
            const { parent, depth } = queue.shift()!;
            const entries = mockFsTree[parent === "" ? "/" : parent];
            if (!entries) continue;
            for (const ent of entries) {
              if (!includeHidden && ent.name.startsWith(".")) continue;
              const full = `${parent === "/" ? "" : parent}/${ent.name}`;
              if (ent.name.toLowerCase().includes(needle)) {
                matches.push({ path: full, name: ent.name, isDir: ent.isDir, parent, depth });
              }
              if (ent.isDir && ent.name !== ".git" && depth < 12) {
                queue.push({ parent: full, depth: depth + 1 });
              }
            }
          }
          return { matches, truncated: false };
        }
        case "fs_create_dir": {
          const path = (args.path as string).replace(/\/+$/, "");
          const cut = path.lastIndexOf("/");
          let parent = cut === 0 ? "/" : path.slice(0, cut);
          if (/^[A-Za-z]:$/.test(parent)) parent += "/";
          const name = path.slice(cut + 1);
          const entries = mockFsTree[parent];
          if (!entries) throw new Error(`no such directory (mock): ${parent}`);
          if (!name || entries.some((entry) => entry.name === name)) {
            throw new Error(`file exists (mock): ${path}`);
          }
          entries.push({ name, isDir: true });
          mockFsTree[path] = [];
          fsCreatedDirs.push(path);
          return null;
        }
        case "fs_trash": {
          const path = (args.path as string).replace(/\/+$/, "");
          const cut = path.lastIndexOf("/");
          let parent = cut === 0 ? "/" : path.slice(0, cut);
          if (/^[A-Za-z]:$/.test(parent)) parent += "/";
          const name = path.slice(cut + 1);
          const entries = mockFsTree[parent];
          const index = entries?.findIndex((entry) => entry.name === name) ?? -1;
          if (!entries || index < 0) throw new Error(`no such entry (mock): ${path}`);
          entries.splice(index, 1);
          for (const key of Object.keys(mockFsTree)) {
            if (key === path || key.startsWith(`${path}/`)) delete mockFsTree[key];
          }
          fsTrashed.push(path);
          return null;
        }
        case "fs_import": {
          const destDir = ((args.destDir as string).replace(/\/+$/, "") || "/") as string;
          const sources = args.sources as string[];
          const destEntries = mockFsTree[destDir];
          if (!destEntries) throw new Error(`no such directory (mock): ${destDir}`);
          const names = new Set<string>();
          for (const source of sources) {
            const parts = source.replace(/\/+$/, "").split("/");
            const name = parts[parts.length - 1] ?? "";
            if (!name || !names.add(name) || destEntries.some((entry) => entry.name === name)) {
              throw new Error(`already exists (mock): ${destDir}/${name}`);
            }
          }
          const importDirs = (w.__mockImportDirs as string[] | undefined) ?? [];
          for (const source of sources) {
            const normalized = source.replace(/\/+$/, "");
            const parts = normalized.split("/");
            const name = parts[parts.length - 1]!;
            const isDir = importDirs.includes(normalized);
            destEntries.push({ name, isDir });
            if (isDir) mockFsTree[`${destDir === "/" ? "" : destDir}/${name}`] = [];
          }
          fsImports.push({ destDir, sources });
          return null;
        }

        case "fs_move": {
          // 実装（Rust の fs_move）と同じガード: 自分の配下は拒否・同名は上書きしない
          const src = (args.src as string).replace(/\/+$/, "");
          const destDir = ((args.destDir as string).replace(/\/+$/, "") || "/") as string;
          if (destDir === src || destDir.startsWith(`${src}/`)) {
            throw new Error("cannot move a folder into itself (mock)");
          }
          const cut = src.lastIndexOf("/");
          let parent = cut === 0 ? "/" : src.slice(0, cut);
          if (/^[A-Za-z]:$/.test(parent)) parent += "/";
          const name = src.slice(cut + 1);
          const srcEntries = mockFsTree[parent];
          const index = srcEntries?.findIndex((entry) => entry.name === name) ?? -1;
          const destEntries = mockFsTree[destDir];
          if (!srcEntries || index < 0) throw new Error(`no such entry (mock): ${src}`);
          if (!destEntries) throw new Error(`no such directory (mock): ${destDir}`);
          const dest = `${destDir === "/" ? "" : destDir}/${name}`;
          if (destEntries.some((entry) => entry.name === name)) {
            throw new Error(`already exists (mock): ${dest}`);
          }
          const [moved] = srcEntries.splice(index, 1);
          destEntries.push(moved);
          for (const key of Object.keys(mockFsTree)) {
            if (key === src || key.startsWith(`${src}/`)) {
              mockFsTree[dest + key.slice(src.length)] = mockFsTree[key];
              delete mockFsTree[key];
            }
          }
          fsMoves.push({ src, destDir });
          return dest;
        }
        case "fs_read": {
          const path = args.path as string;
          // 隠しファイルはバイナリ扱いのテスト用にする
          if (path === "/home/user/.hidden-file") return { text: "", truncated: false, binary: true };
          const text = mockFsFiles[path];
          if (text === undefined) throw new Error(`no such file (mock): ${path}`);
          return { text, truncated: false, binary: false };
        }
        case "fs_read_image": {
          // 1x1 PNG。raw IPC response と同様、数値配列ではなくバイト列を返す。
          const base64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
          return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        }
        case "fs_write": {
          const path = args.path as string;
          const text = args.text as string;
          fsWrites.push({ path, text });
          mockFsFiles[path] = text;
          return null;
        }
        case "pty_agents": {
          // テストから window.__mockPtyAgents（ペインID → 種別 or null）で注入。
          // 既定は「どのペインでもエージェントは動いていない」
          if (!Array.isArray(w.__ptyAgentCalls)) w.__ptyAgentCalls = [];
          const ids = args.ids as string[];
          (w.__ptyAgentCalls as unknown[]).push(ids);
          const byId = (w.__mockPtyAgents as Record<string, string | null> | undefined) ?? {};
          return Object.fromEntries(ids.map((id) => [id, byId[id] ?? null]));
        }
        case "agent_session_id": {
          // テストから window.__mockAgentSessionId で注入。null = 解決不能
          if (!Array.isArray(w.__agentSessionIdCalls)) w.__agentSessionIdCalls = [];
          (w.__agentSessionIdCalls as unknown[]).push({
            kind: args.kind,
            cwd: args.cwd,
            sinceMs: args.sinceMs,
          });
          return (w.__mockAgentSessionId as string | null) ?? null;
        }
        case "agent_session_list": {
          // テストから window.__mockAgentSessionList（配列）で注入。
          // __mockAgentSessionListError で失敗も再現できる
          if (!Array.isArray(w.__agentSessionListCalls)) w.__agentSessionListCalls = [];
          (w.__agentSessionListCalls as unknown[]).push(true);
          if (w.__mockAgentSessionListError) throw new Error(String(w.__mockAgentSessionListError));
          return (w.__mockAgentSessionList as unknown[]) ?? [];
        }
        case "pty_cwd": {
          // テストから window.__mockPtyCwd で注入。ペイン別マップがあれば
          // そちらを優先する。null → フロントは OSC 7 側へフォールバック。
          const byId = w.__mockPtyCwdById as Record<string, string | null> | undefined;
          const id = args.id as string;
          if (byId && Object.prototype.hasOwnProperty.call(byId, id)) return byId[id];
          return (w.__mockPtyCwd as string | null) ?? null;
        }
        case "git_changes": {
          // テストから window.__mockGitChanges で注入。既定は「リポジトリ外」。
          // 監視先 cwd の追従検証用に呼び出し履歴を残す
          if (!Array.isArray(w.__gitCalls)) w.__gitCalls = [];
          const cwd = args.cwd as string;
          (w.__gitCalls as unknown[]).push(cwd);
          // ポーリング中の cwd 切替を再現する回帰テスト用。実際の git コマンドと同じく、
          // 応答は呼び出し時に渡された cwd に対応する。
          const delayByCwd = w.__mockGitChangeDelayByCwd as Record<string, number> | undefined;
          const delay = delayByCwd?.[cwd] ?? 0;
          if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
          const byCwd = w.__mockGitChangesByCwd as Record<string, object> | undefined;
          return byCwd?.[cwd]
            ?? (w.__mockGitChanges as object)
            ?? { repo: false, root: null, files: [] };
        }
        case "git_summary": {
          // テストから window.__mockGitSummary で注入。既定は「リポジトリ外」。
          // 呼び出し履歴（cwd）はサイドバーバッジの追従検証用
          if (!Array.isArray(w.__gitSummaryCalls)) w.__gitSummaryCalls = [];
          (w.__gitSummaryCalls as unknown[]).push(args.cwd);
          return (
            (w.__mockGitSummaryByCwd as Record<string, object> | undefined)?.[args.cwd as string]
            ?? (w.__mockGitSummary as object) ?? {
              repo: false,
              root: null,
              branch: null,
              fileCount: 0,
              adds: 0,
              dels: 0,
            }
          );
        }
        case "git_file_diff":
          return (w.__mockGitFileDiff as object) ?? { oldText: "", newText: "" };
        case "git_worktree_diff": {
          if (!Array.isArray(w.__gitWorktreeDiffCalls)) w.__gitWorktreeDiffCalls = [];
          (w.__gitWorktreeDiffCalls as unknown[]).push(args.cwd);
          return (
            (w.__mockGitWorktreeDiff as object) ?? {
              patch: "",
              adds: 0,
              dels: 0,
              truncated: false,
            }
          );
        }
        case "git_commit_diff": {
          if (!Array.isArray(w.__gitCommitDiffCalls)) w.__gitCommitDiffCalls = [];
          (w.__gitCommitDiffCalls as unknown[]).push({ root: args.root, hash: args.hash });
          return (
            (w.__mockGitCommitDiff as object) ?? {
              patch: "",
              adds: 0,
              dels: 0,
              truncated: false,
            }
          );
        }
        case "git_reset_to_commit": {
          if (!Array.isArray(w.__gitResetCalls)) w.__gitResetCalls = [];
          (w.__gitResetCalls as unknown[]).push({ root: args.root, hash: args.hash });
          if (w.__mockGitResetError) throw new Error(String(w.__mockGitResetError));
          return `HEAD is now at ${String(args.hash)}`;
        }
        case "git_log": {
          // テストから window.__mockGitLog で注入。既定は「リポジトリ外」。
          // 呼び出し履歴（cwd）はエクスプローラー下部 git セクションの追従検証用
          if (!Array.isArray(w.__gitLogCalls)) w.__gitLogCalls = [];
          (w.__gitLogCalls as unknown[]).push(args.cwd);
          return (
            (w.__mockGitLog as object) ?? {
              repo: false,
              root: null,
              branch: null,
              detached: false,
              commits: [],
            }
          );
        }
        case "pr_info": {
          // テストから window.__mockPrInfo で注入。既定は「PR 無し」（gh 不在と同じ退化）
          if (!Array.isArray(w.__prCalls)) w.__prCalls = [];
          (w.__prCalls as unknown[]).push({ root: args.root, branch: args.branch });
          return (
            (w.__mockPrInfo as object) ?? {
              found: false,
              number: null,
              title: null,
              state: null,
              url: null,
              author: null,
              body: null,
              additions: 0,
              deletions: 0,
              changedFiles: 0,
              files: [],
              comments: [],
            }
          );
        }
        case "pr_list": {
          if (!Array.isArray(w.__prListCalls)) w.__prListCalls = [];
          (w.__prListCalls as unknown[]).push(args.root);
          return (w.__mockPrList as object) ?? { available: true, prs: [] };
        }
        case "pr_detail": {
          if (!Array.isArray(w.__prDetailCalls)) w.__prDetailCalls = [];
          (w.__prDetailCalls as unknown[]).push({ root: args.root, number: args.number });
          return (w.__mockPrDetail as object) ?? (w.__mockPrInfo as object) ?? {
            found: false,
            number: null,
            title: null,
            state: null,
            url: null,
            author: null,
            body: null,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            files: [],
            comments: [],
          };
        }
        case "pr_diff": {
          if (!Array.isArray(w.__prDiffCalls)) w.__prDiffCalls = [];
          (w.__prDiffCalls as unknown[]).push({ root: args.root, number: args.number });
          if (w.__mockPrDiffError) throw new Error(String(w.__mockPrDiffError));
          return (w.__mockPrDiff as object) ?? {
            patch: "",
            adds: 0,
            dels: 0,
            truncated: false,
          };
        }
        case "issue_list": {
          if (!Array.isArray(w.__issueListCalls)) w.__issueListCalls = [];
          (w.__issueListCalls as unknown[]).push(args.root);
          return (w.__mockIssueList as object) ?? { available: true, issues: [] };
        }
        case "issue_info": {
          if (!Array.isArray(w.__issueInfoCalls)) w.__issueInfoCalls = [];
          (w.__issueInfoCalls as unknown[]).push({ root: args.root, number: args.number });
          return (
            (w.__mockIssueInfo as object) ?? {
              found: false,
              number: null,
              title: null,
              state: null,
              url: null,
              author: null,
              body: null,
              labels: [],
              comments: [],
            }
          );
        }
        case "git_worktree_branches":
          return (
            (w.__mockWorktreeBranches as object) ?? {
              branches: [{ name: "main", reference: "refs/heads/main", current: true }],
            }
          );
        case "git_worktree_create": {
          if (!Array.isArray(w.__worktreeCreateCalls)) w.__worktreeCreateCalls = [];
          (w.__worktreeCreateCalls as unknown[]).push({
            root: args.root,
            baseRef: args.baseRef,
            branch: args.branch,
            directory: args.directory,
            location: args.location,
          });
          const r = w.__mockWorktreeResult as { error?: string; path?: string; branch?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return {
            path: r?.path ?? `${String(args.root)}/${String(args.directory)}/issue-1`,
            branch: r?.branch ?? args.branch,
            reused: false,
          };
        }
        case "git_worktree_from_pr": {
          if (!Array.isArray(w.__worktreeFromPrCalls)) w.__worktreeFromPrCalls = [];
          (w.__worktreeFromPrCalls as unknown[]).push({
            root: args.root,
            number: args.number,
            branch: args.branch,
            directory: args.directory,
            location: args.location,
          });
          const r = w.__mockWorktreeFromPrResult as
            | { error?: string; path?: string; branch?: string; reused?: boolean }
            | undefined;
          if (r?.error) throw new Error(r.error);
          return {
            path: r?.path ?? `${String(args.directory)}/${String(args.branch)}`,
            branch: r?.branch ?? args.branch,
            reused: r?.reused ?? false,
          };
        }
        case "git_worktree_list": {
          if (!Array.isArray(w.__worktreeListCalls)) w.__worktreeListCalls = [];
          (w.__worktreeListCalls as unknown[]).push({ root: args.root });
          const r = w.__mockWorktreeList as { error?: string; entries?: unknown[] } | undefined;
          if (r?.error) throw new Error(r.error);
          return {
            entries: r?.entries ?? [
              {
                path: String(args.root),
                branch: "main",
                head: "abc1234",
                isMain: true,
                isCurrent: true,
                detached: false,
                bare: false,
                locked: false,
                lockReason: "",
                missing: false,
              },
            ],
          };
        }
        case "git_worktree_remove": {
          if (!Array.isArray(w.__worktreeRemoveCalls)) w.__worktreeRemoveCalls = [];
          (w.__worktreeRemoveCalls as unknown[]).push({
            root: args.root,
            path: args.path,
            force: args.force,
          });
          // 強制削除の導線を試せるよう、force のときだけ成功させる指定もできる
          const r = w.__mockWorktreeRemoveResult as
            | { error?: string; errorUnlessForce?: string }
            | undefined;
          if (r?.error) throw new Error(r.error);
          if (r?.errorUnlessForce && !args.force) throw new Error(r.errorUnlessForce);
          return null;
        }
        case "issue_link_branch": {
          if (!Array.isArray(w.__issueLinkBranchCalls)) w.__issueLinkBranchCalls = [];
          (w.__issueLinkBranchCalls as unknown[]).push({
            root: args.root,
            number: args.number,
            branch: args.branch,
          });
          const r = w.__mockIssueLinkBranchResult as
            | { error?: string; branch?: string; remote?: string }
            | undefined;
          if (r?.error) throw new Error(r.error);
          return { branch: r?.branch ?? args.branch, remote: r?.remote ?? "origin" };
        }
        case "git_branches":
          // テストから window.__mockGitBranches で注入。既定は「リモート無し」
          return (
            (w.__mockGitBranches as object) ??
            { current: null, upstream: null, localBranches: [], branches: [], remotes: [] }
          );
        case "git_switch_branch": {
          if (!Array.isArray(w.__gitSwitchBranchCalls)) w.__gitSwitchBranchCalls = [];
          (w.__gitSwitchBranchCalls as unknown[]).push({ root: args.root, branch: args.branch });
          const r = w.__mockGitSwitchBranchResult as { error?: string; out?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return r?.out ?? `Switched to branch '${String(args.branch)}' (mock)`;
        }
        case "git_stash": {
          // 呼び出し履歴（cwd）はストリップの Stash ボタン検証用
          if (!Array.isArray(w.__gitStashCalls)) w.__gitStashCalls = [];
          (w.__gitStashCalls as unknown[]).push(args.cwd);
          const r = w.__mockGitStashResult as { error?: string; out?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return r?.out ?? "Saved working directory and index state WIP (mock)";
        }
        case "git_commit": {
          if (!Array.isArray(w.__gitCommitCalls)) w.__gitCommitCalls = [];
          (w.__gitCommitCalls as unknown[]).push({ cwd: args.cwd, message: args.message, paths: args.paths });
          const r = w.__mockGitCommitResult as { error?: string; out?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return r?.out ?? `[main abc1234] ${String(args.message)}`;
        }
        case "git_push": {
          if (!Array.isArray(w.__gitPushCalls)) w.__gitPushCalls = [];
          (w.__gitPushCalls as unknown[]).push({ root: args.root });
          const r = w.__mockGitPushResult as { error?: string; out?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return r?.out ?? "Everything up-to-date (mock)";
        }
        case "git_fetch": {
          if (!Array.isArray(w.__gitFetchCalls)) w.__gitFetchCalls = [];
          (w.__gitFetchCalls as unknown[]).push({ root: args.root });
          const r = w.__mockGitFetchResult as { error?: string; out?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return r?.out ?? "Fetched all remotes. (mock)";
        }
        case "git_pull": {
          if (!Array.isArray(w.__gitPullCalls)) w.__gitPullCalls = [];
          (w.__gitPullCalls as unknown[]).push({ root: args.root, branch: args.branch });
          const r = w.__mockGitPullResult as { error?: string; out?: string } | undefined;
          if (r?.error) throw new Error(r.error);
          return r?.out ?? "Already up to date. (mock)";
        }
        case "session_save":
          w.__savedSession = args.data;
          return null;
        case "session_load":
          // テストから window.__mockSessionLoad で復元データを注入できる
          return (w.__mockSessionLoad as string) ?? null;
        case "app_version":
          return "0.2.0";
        case "update_check": {
          // テストから window.__mockUpdateResult で結果を注入できる（{error} なら失敗）
          const r = w.__mockUpdateResult as ({ error?: string } & Record<string, unknown>) | undefined;
          if (r?.error) throw new Error(r.error);
          return (
            r ?? {
              current: "0.2.0",
              latest: "v0.2.0",
              url: "https://github.com/saisai-web/PATerminal/releases/latest",
            }
          );
        }
        case "official_update_check":
          return (w.__mockOfficialUpdate as object | null) ?? null;
        case "official_update_install": {
          if (!Array.isArray(w.__officialUpdateInstallCalls)) w.__officialUpdateInstallCalls = [];
          (w.__officialUpdateInstallCalls as unknown[]).push(true);
          const channel = args.onEvent as { onmessage?: (event: unknown) => void } | undefined;
          channel?.onmessage?.({ event: "Started", data: { contentLength: 100 } });
          channel?.onmessage?.({ event: "Progress", data: { chunkLength: 50 } });
          channel?.onmessage?.({ event: "Progress", data: { chunkLength: 50 } });
          channel?.onmessage?.({ event: "Finished" });
          if (w.__mockOfficialUpdateInstallError) throw new Error(String(w.__mockOfficialUpdateInstallError));
          return null;
        }
        case "open_url":
        case "open_terminal_url": {
          if (!Array.isArray(w.__openedUrls)) w.__openedUrls = [];
          (w.__openedUrls as unknown[]).push(args.url);
          return null;
        }
        case "eula_status": {
          const locale = typeof args.locale === "string" ? args.locale : "en";
          if (!Array.isArray(w.__eulaStatusLocales)) w.__eulaStatusLocales = [];
          (w.__eulaStatusLocales as unknown[]).push(locale);
          const localized = (w.__mockEulas as Record<string, Record<string, unknown>> | undefined)?.[locale];
          return (
            localized ?? (w.__mockEula as Record<string, unknown>) ?? {
              official: false,
              version: "1.0",
              effectiveDate: "2026-08-24",
              accepted: true,
              url: "https://paralellterminal.com/eula",
              text: "# PATerminal End User License Agreement (EULA)\n\nVersion 1.0",
              resolvedLocale: "en",
              authoritativeLocale: "en",
              isTranslation: false,
            }
          );
        }
        case "eula_accept": {
          if (!Array.isArray(w.__eulaAcceptCalls)) w.__eulaAcceptCalls = [];
          (w.__eulaAcceptCalls as unknown[]).push(args.version);
          const current = (w.__mockEula as Record<string, unknown> | undefined) ?? {};
          w.__mockEula = { ...current, accepted: true };
          return null;
        }
        case "eula_decline":
          w.__eulaDeclined = true;
          return null;
        case "third_party_notices":
          return "# PATerminal Third-Party Notices\n\nMock dependency — MIT";
        // ライセンス / トライアル / ソフトロック。既定は自ビルド相当（unlocked）なので
        // 既存スイートには影響しない。テストは window.__mockLicense で状態を注入する
        case "license_status":
          return (
            (w.__mockLicense as Record<string, unknown>) ?? {
              official: false,
              state: "selfbuild",
              locked: false,
              daysLeft: null,
              supporter: false,
              keyMasked: null,
              keyKind: null,
              retrialAvailable: false,
              banner: null,
              guidePending: false,
              checkoutUrl: "https://polar.sh/checkout/PLACEHOLDER",
            }
          );
        case "license_activate": {
          if (!Array.isArray(w.__licenseActivateCalls)) w.__licenseActivateCalls = [];
          (w.__licenseActivateCalls as unknown[]).push(args.key);
          const r = w.__mockLicenseActivate as
            | ({ error?: string } & Record<string, unknown>)
            | undefined;
          if (r?.error) throw new Error(r.error);
          if (r) return r;
          // 既定は成功。ロック注入中のテストは登録で解除された状態を返す
          const cur = (w.__mockLicense as Record<string, unknown>) ?? {};
          const status = {
            ...cur,
            state: "licensed",
            locked: false,
            keyMasked: "…MOCK",
            keyKind: "dev",
            banner: null,
          };
          w.__mockLicense = status;
          return { kind: "activated", status };
        }
        case "license_deactivate": {
          const cur = (w.__mockLicense as Record<string, unknown>) ?? {};
          const status = { ...cur, keyMasked: null, keyKind: null };
          w.__mockLicense = status;
          return status;
        }
        case "license_devices":
          return (w.__mockLicenseDevices as unknown[]) ?? [];
        case "license_device_remove": {
          if (!Array.isArray(w.__licenseDeviceRemoveCalls)) w.__licenseDeviceRemoveCalls = [];
          (w.__licenseDeviceRemoveCalls as unknown[]).push(args.activationId);
          return null;
        }
        case "license_retrial": {
          const cur = (w.__mockLicense as Record<string, unknown>) ?? {};
          const status = {
            ...cur,
            state: "retrial",
            locked: false,
            daysLeft: 7,
            retrialAvailable: false,
          };
          w.__mockLicense = status;
          return status;
        }
        case "license_banner_seen": {
          if (!Array.isArray(w.__licenseBannersSeen)) w.__licenseBannersSeen = [];
          (w.__licenseBannersSeen as unknown[]).push(args.id);
          return null;
        }
        case "license_guide_dismiss": {
          w.__licenseGuideDismissed = true;
          return null;
        }
        case "license_update_notify":
          return (w.__mockUpdateNotify as Record<string, unknown>) ?? { off: false, due: false };
        case "reveal_path": {
          // Finder / Explorer 表示の呼び出し履歴（テスト検証用）
          if (!Array.isArray(w.__revealedPaths)) w.__revealedPaths = [];
          (w.__revealedPaths as unknown[]).push(args.path);
          return null;
        }
        case "open_path": {
          // 既定アプリで開く呼び出し履歴（テスト検証用）
          if (!Array.isArray(w.__openedPaths)) w.__openedPaths = [];
          (w.__openedPaths as unknown[]).push(args.path);
          return null;
        }
        default:
          return null;
      }
    },
  };
}

export {};
