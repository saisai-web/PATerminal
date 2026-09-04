// ============================================================
// Pane
// ============================================================

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel, invoke } from "@tauri-apps/api/core";
import { copyText } from "../shared/clipboard";
import { updateWsActivity } from "../app/activity";
import { updateGitWatch } from "../features/git/agent-panel";
import { MIN_FIT_COLS, MIN_FIT_ROWS, SNAPSHOT_LINES } from "../shared/constants";
import { diag, diagPush } from "./diag";
import { isLocked } from "../features/license/license";
import { markSpawned, registerPane, requestResize, unregisterPane } from "./resize";
import { explorerFollow, renderExplorerFavs } from "../features/explorer/explorer";
import { broadcastWrite, setFocused } from "./focus";
import { t } from "../i18n";
import { startInlineEdit } from "../shared/inline-edit";
import { scheduleSave } from "../app/session";
import { getTheme, isAutoEnterEnabledForWorkspace } from "../features/settings/settings-panel";
import { renderSidebar } from "../features/sidebar/sidebar";
import { resumeCommandFor } from "../features/agents/agents";
import { getFocusedId, getHostOs, panes } from "../workspace/state";
import { XTERM_MINIMUM_CONTRAST_RATIO, xtermThemeFor } from "../features/settings/themes";
import { closePane } from "./tree";
import { updateWsGit } from "../features/sidebar/ws-git";
import type { PaneSpec, Rect, ShellKind, Workspace } from "../workspace/types";

export function shellForKind(kind: ShellKind): string | undefined {
  if (kind === "powershell") {
    // Windows: pwsh(7系) が無い環境を考慮して同梱の powershell.exe。
    // macOS/Linux: brew 等で入る pwsh。未インストールなら spawn が失敗し、
    // そのエラーがペインに表示される（アプリは落とさない）
    return getHostOs() === "windows" ? "powershell.exe" : "pwsh";
  }
  if (kind === "cmd") return "cmd.exe";
  return undefined; // default → Rust 側の default_shell() に任せる
}

/**
 * ターミナル上のコピー / 貼り付けショートカット。
 *
 * xterm は Ctrl+C / Ctrl+V を「^C / ^V を送る打鍵」として処理し、最後に必ず
 * preventDefault するので、**WebView 既定のコピー・貼り付けが動かない**
 * （Ctrl+V が ^V を送るだけになる）。ここで拾って xterm より先に振り分ける。
 *
 * - Windows: Ctrl+V / Ctrl+Shift+V で貼り付け、Ctrl+Shift+C と
 *   「選択があるときの Ctrl+C」でコピー（コンソール / Windows Terminal と同じ流儀）
 * - Linux: Ctrl+Shift+C / Ctrl+Shift+V のみ。素の Ctrl+V は readline の
 *   quoted-insert、Ctrl+C は SIGINT なので奪わない
 * - macOS: 何もしない。Cmd+C / Cmd+V は xterm が横取りしないので WKWebView の
 *   既定動作がそのまま効いており、Ctrl+V は quoted-insert のまま残す
 */
function clipboardShortcut(ev: KeyboardEvent): "copy" | "paste" | null {
  const os = getHostOs();
  if (os === "macos" || !ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  const key = ev.key.toLowerCase();
  if (key === "v" && (ev.shiftKey || os === "windows")) return "paste";
  if (key === "c" && (ev.shiftKey || os === "windows")) return "copy";
  return null;
}

/**
 * 保存済みの表示履歴や異常終了した TUI から、対話シェルへ持ち越してはいけない
 * xterm のモードを既定値へ戻す。PTY へは送らず、表示側だけを正規化する。
 *
 * 古い session.json には SerializeAddon が付けた application cursor / mouse /
 * bracketed paste / alternate buffer 等が残っているため、新規保存を直すだけでは足りない。
 */
const INTERACTIVE_MODE_RESET = [
  "\x1b[?1049l", // alternate buffer から通常バッファへ戻す
  "\x1b[?1l", // application cursor keys OFF
  "\x1b[?66l", // application keypad OFF
  "\x1b[?2004l", // bracketed paste OFF
  "\x1b[4l", // insert mode OFF
  "\x1b[?6l", // origin mode OFF
  "\x1b[?45l", // reverse wraparound OFF
  "\x1b[?1004l", // focus reporting OFF
  "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l", // mouse tracking OFF
  "\x1b[?7h", // wraparound ON
  "\x1b[?25h", // cursor visible
  "\x1b[0m", // character attributes reset
].join("");

function emergencyShell(): { shell: string; args: string[] } {
  return getHostOs() === "windows"
    ? { shell: "cmd.exe", args: [] }
    : { shell: "/bin/sh", args: ["-i"] };
}

function retryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * ユーザーの打鍵ではなく、ターミナル側が自動で生成して PTY へ流すデータか。
 * - TUI の問い合わせへの応答: CPR / DECXCPR（`ESC [ r ; c R`）、DA1 / DA2 / DECRQM など
 *   private prefix 付き CSI（`ESC [ ?` / `ESC [ >`）、DSR（`ESC [ 0 n`）、OSC 色応答、
 *   DCS（DECRQSS）応答。claude / codex は起動時とリサイズ時にこれらを問い合わせる
 * - フォーカス通知 `ESC [ I` / `ESC [ O`（DECSET 1004。セッション切替の focus() で出る）
 * - マウス報告（SGR / X10）と、alt buffer でホイールが変換される上下矢印
 * これらを「操作」と数えると、開いただけ・見ただけのペインが実行中になって
 * 完了通知が量産される。
 */
const UNSOLICITED_TERMINAL_DATA: RegExp[] = [
  /^\x1b\[[?>]/,
  /^\x1b\[\d+;\d+R$/,
  /^\x1b\[\d*n$/,
  /^\x1b\]/,
  /^\x1bP[\s\S]*\x1b\\$/,
  /^\x1b\[[IO]$/,
  /^\x1b\[<\d+;\d+;\d+[Mm]$/,
  /^\x1b\[M[\s\S]{3}$/,
  /^(\x1b(\[|O)[ABCD])+$/,
];

export function isUnsolicitedTerminalData(data: string): boolean {
  if (data.charCodeAt(0) !== 0x1b) return false;
  return UNSOLICITED_TERMINAL_DATA.some((re) => re.test(data));
}

export class Pane {
  readonly id: string;
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  readonly spec: PaneSpec;
  readonly ws: Workspace;
  /** OSC 7 で追跡した現在ディレクトリ。取れなければ spec.cwd のまま。 */
  cwd?: string;
  /** ターミナル起動時のディレクトリ。spec.cwd 指定が無ければ最初の OSC 7 で確定し、
      以降は変わらない（エクスプローラーの ⌂ の戻り先） */
  initialCwd?: string;
  alive = true;
  /** PTY 出力が流れている最中か（Rust の pty:act イベントで遷移）。保存しない */
  busy = false;
  /** 静止した画面の末尾が「応答しないと進まない」表示だったか（Rust 側で判定）。
      次に出力が流れれば解除される。保存しない */
  waiting = false;
  /** Rust が PTY 出力から追跡した bracketed paste (DECSET 2004) の状態（pty:mode）。
      非表示ペインは xterm にバイトが届かず term.modes が古いままなので、こちらが正。
      イベント未着（起動直後）は undefined → term.modes へフォールバック。保存しない */
  bracketedPaste?: boolean;
  /** 初回のシェル起動出力が静止済みか。起動音の BEL を入力待ちと誤認しないために使う */
  activityReady = false;
  /** spec.run / resumeRun を PTY へ送信済みか。ペアの起動待ちで、先行するシェル初期化の
      静止とエージェント起動後の静止を区別するためのランタイム状態。 */
  startupRunSent = false;
  /** ターミナル操作または実際の agent 作業が始まったか。単なる起動出力を実行中にしない */
  activityEngaged: boolean;
  /** 出力の途中で鳴った BEL。静止するまで通知を保留し、入力待ちか完了かを見てから出す */
  bellPending = false;

  private readonly fit = new FitAddon();
  private readonly serializer = new SerializeAddon();
  /** 復元時に流し込む前回のスクロールバック */
  private readonly restoreText?: string;
  /** true ならセッション復元起動（run ではなく resumeRun を使う） */
  private readonly resumed: boolean;
  private readonly cwdEl: HTMLSpanElement;
  /** セッションメモはツリー先頭 leaf のペインバーだけに表示する。 */
  private readonly noteEl: HTMLDivElement;
  private webglLoaded = false;
  /** 要素サイズの変化を拾う保険。layout() を呼び忘れた経路（モーダルの開閉など）でも
      サイズを合わせ直す。ポーリングではなくイベント駆動 */
  private ro?: ResizeObserver;
  private refitRaf = 0;
  /** WebKit の遅延リフロー後にも末尾へ合わせ直すための rAF。 */
  private scrollBottomRaf = 0;
  /** destroy でまとめて外す xterm のイベント購読 */
  private readonly disposables: { dispose(): void }[] = [];
  /** 直近のスクロールバックスナップショット。出力が来るたび dirty になる */
  private snapshotCache?: string;
  private snapshotDirty = true;
  /** 終了通知とフォールバック起動が重なって二重 spawn しないためのガード。 */
  private recovering = false;
  /** destroy 中に進行中の spawn が完了しても孤児 PTY を残さないための印。 */
  private destroyed = false;
  /** pty_write の直列化キュー。IPC は完了順序が呼び出し順と一致する保証がないため、
      前の書き込み完了を待ってから次を送る。失敗も握りつぶさずログに出す。 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(ws: Workspace, spec: PaneSpec, opts: { scrollback?: string; resumed?: boolean } = {}) {
    this.id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.ws = ws;
    this.spec = spec;
    this.cwd = spec.cwd;
    this.initialCwd = spec.cwd;
    this.restoreText = opts.scrollback;
    this.resumed = opts.resumed ?? false;
    // エージェントを直接復元しただけでは、初期画面の描画まで「実行中」になってしまう。
    // ユーザー入力やペアモードの実際の依頼を受けるまでは、通常のシェルと同じく完了のままにする。
    this.activityEngaged = false;
    this.activityReady = false;

    this.el = document.createElement("div");
    this.el.className = "pane";

    const bar = document.createElement("div");
    bar.className = "pane-bar";
    const head = document.createElement("div");
    head.className = "pane-bar-head";
    const label = document.createElement("span");
    label.className = "pane-title";
    label.textContent = spec.title ?? "shell";
    // ダブルクリックでペイン名をその場で編集（表示名のみ。プロセスには影響しない）
    label.ondblclick = (e) => {
      e.stopPropagation();
      startInlineEdit(label, this.spec.title ?? "shell", (v) => {
        this.spec.title = v;
        scheduleSave();
      });
    };
    this.cwdEl = document.createElement("span");
    this.cwdEl.className = "pane-cwd";
    this.cwdEl.textContent = this.cwd ?? "";
    const close = document.createElement("button");
    close.className = "pane-close";
    close.textContent = "close";
    close.onclick = (e) => {
      e.stopPropagation();
      void closePane(this.ws, this.id);
    };
    head.append(label, this.cwdEl, close);
    this.noteEl = document.createElement("div");
    this.noteEl.className = "pane-note";
    this.noteEl.hidden = true;
    bar.append(head, this.noteEl);

    const body = document.createElement("div");
    body.className = "pane-body";
    this.el.append(bar, body);

    this.term = new Terminal({
      fontFamily: '"SFMono-Regular", "Cascadia Mono", "Menlo", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      // claude / codex は入力・返答・承認 UI で ANSI 前景色と背景色を組み合わせる。
      // テーマと同系色になっても文字の輪郭が消えないよう、セル単位で前景色を補正する。
      minimumContrastRatio: XTERM_MINIMUM_CONTRAST_RATIO,
      theme: xtermThemeFor(getTheme()),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.serializer);
    // 出力中の URL を Cmd（macOS）/ Ctrl（Windows / Linux）+ クリックで既定ブラウザで開く。
    // 修飾なしのクリックは従来どおり（選択・TUI へのマウスイベント）なので誤爆しない。
    // WKWebView に window.open は無いので Rust の open_terminal_url（http/https 限定）へ渡す
    this.term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        if (!ev.metaKey && !ev.ctrlKey) return;
        void invoke("open_terminal_url", { url: uri }).catch(() => {});
      }),
    );

    // WKWebView は高速なロールオーバー入力や Shift 併用時に keypress を発火せず、
    // さらにその keydown へ keyCode=229（IME処理中の印）を付けることがある。
    // xterm は「keydown を見たら input イベントを無視する」(_keyDownSeen) ため、
    // この組み合わせで打鍵が欠ける（keydown 自体は 100% 届くことを診断ログで確認済み）。
    // 対応:
    //   - 印字キー（229以外）: keydown から直接注入し keypress には頼らない
    //   - keyCode=229: xterm の処理（レースのある textarea 差分ハック）を止め、
    //     既定動作で textarea に挿入させて input イベント（下のリスナー）で拾う
    //   - IME 合成中（isComposing）は composition イベントに任せる
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown") {
        const clip = clipboardShortcut(ev);
        if (clip === "paste") {
          // preventDefault しない = WebView 既定の貼り付けをそのまま通す。
          // false を返すと xterm は _keyDown を即抜けるので cancel() されず、
          // 続く paste イベントを xterm 内蔵のハンドラが受けて PTY へ流す
          return false;
        }
        if (clip === "copy") {
          const text = this.term.getSelection();
          // 選択が無いときの Ctrl+C は従来どおり SIGINT（^C）を送る
          if (!text) return !ev.shiftKey;
          ev.preventDefault();
          void copyText(text);
          // 選択を残すと次の Ctrl+C もコピーになり、SIGINT を送れなくなる
          this.term.clearSelection();
          return false;
        }
      }
      if (
        ev.type === "keydown" &&
        ev.key.length === 1 &&
        !ev.metaKey &&
        !ev.ctrlKey &&
        !ev.isComposing
      ) {
        if (ev.keyCode === 229) {
          return false;
        }
        ev.preventDefault();
        this.term.input(ev.key, true);
        return false;
      }
      if (ev.type === "keypress" && ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) {
        return false;
      }
      return true;
    });

    this.term.open(body);
    registerPane(this.id);
    // body（= FitAddon が測る親要素）のサイズ変化で確実に再フィットする。
    // layout() 側の refit はそのまま残し、これは取りこぼし用の保険
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.scheduleRefit());
      this.ro.observe(body);
    }

    // keyCode=229 で既定挿入された文字を確実に回収する（insertText はここに一本化）。
    const ta = this.term.textarea;
    if (ta) {
      // 貼り付けは xterm 内蔵の paste ハンドラ（この listener より先に登録されている）が
      // bracketed paste 込みで PTY へ流し終えている。既定動作まで通すと同じ文字列が
      // 隠し textarea にも残るので、ここで打ち切る
      ta.addEventListener("paste", (e) => e.preventDefault());
      ta.addEventListener("input", (e) => {
        const ie = e as InputEvent;
        if (ie.defaultPrevented || ie.isComposing) return;
        if (ie.inputType !== "insertText" || !ie.data) return;
        diagPush(`ta:${ie.data}`);
        this.term.input(ie.data, true);
        ta.value = "";
      });
    }

    // xterm 内蔵の input イベントフォールバックは _keyDownSeen の状態次第で
    // 動いたり動かなかったりする。WebKit は input → keydown の順で届けることが
    // あり、その場合に内蔵経路と上のリスナーが両方動いて二重入力になる。
    // _keyDownSeen は内蔵 input 経路の判定にしか使われていないため、常に true に
    // 固定して内蔵経路を無効化し、insertText の取り込みを一本化する。
    // （private API 依存。xterm 更新時は挙動を要確認）
    try {
      const core = (this.term as unknown as { _core: object })._core;
      Object.defineProperty(core, "_keyDownSeen", { get: () => true, set: () => {} });
    } catch {
      /* 固定に失敗しても入力自体は動く（稀に二重が残るだけ） */
    }

    // OSC 7: シェルが cwd を "file://host/path" で通知してくる
    this.term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol === "file:") {
          let p = decodeURIComponent(url.pathname);
          // Windows: "/C:/Users/..." → "C:/Users/..."
          if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
          // 同じ cwd の再通知（プロンプト表示のたびに来る）では何もしない
          if (p !== this.cwd) {
            // 最初の通知 = 起動ディレクトリ。以降の cd では動かさない
            if (this.initialCwd === undefined) this.initialCwd = p;
            this.cwd = p;
            this.cwdEl.textContent = p;
            scheduleSave();
            renderSidebar();
            updateWsGit(); // 非アクティブセッションの cd でもバッジを追従させる
            // フォーカス中ペインの cd なら「セッションの現在地」ピン・git 監視・
            // エクスプローラーの表示先も追従
            if (this.id === getFocusedId()) {
              renderExplorerFavs();
              updateGitWatch();
              explorerFollow(p);
            }
          }
        }
      } catch {
        /* 不正な OSC 7 は無視 */
      }
      return true;
    });

    this.el.addEventListener("mousedown", (e) => {
      // インライン編集中の input からフォーカスを奪わない（奪うと blur で編集が確定してしまう）
      if (e.target instanceof HTMLInputElement) return;
      setFocused(this.id);
    });
    void this.start();
  }

  private async start() {
    // 前回の画面内容を先に描く。PTY 出力より前でなければならない。
    // 古い保存データが入力・マウス・alternate buffer のモードを含んでいても、
    // 表示履歴の直後で必ず解除し、ライブな対話シェルへ持ち越さない。
    if (this.restoreText) {
      this.term.write(this.restoreText);
      this.term.write(`${INTERACTIVE_MODE_RESET}\r\n\x1b[2m── ${t("pane.restored")} ──\x1b[0m\r\n`);
    }

    // 打鍵は PTY 起動前から受け付ける: onData を spawn より先に張り、
    // write() の直列化キューを「spawn 完了で解放されるゲート」から始める。
    // これで起動待ちの間に打った文字も失わず、起動後にまとめて届く
    let spawnDone!: () => void;
    this.writeChain = new Promise<void>((resolve) => (spawnDone = resolve));

    this.term.onData((data) => {
      // TUI の問い合わせに xterm が自動で返す応答（カーソル位置・DA・色）やフォーカス
      // 通知は、PTY へは転送するがユーザー操作とは数えない（claude / codex を開いた
      // だけで「実行中」にしない）。
      const marksActivity = !isUnsolicitedTerminalData(data);
      if (marksActivity) this.activityEngaged = true;
      diag.data += data.length;
      diagPush(`d:${data.length <= 4 ? JSON.stringify(data) : data.length}`);
      const isEnter = data === "\r" || data === "\n";
      if (this.ws.broadcast || (isEnter && isAutoEnterEnabledForWorkspace(this.ws))) {
        broadcastWrite(this.ws, data, marksActivity);
      } else {
        this.write(data, marksActivity);
      }
    });

    // **spawn の前に購読する。** ペインは DOM へ挿入される前に spawn されるので
    // term.cols/rows はまだ既定の 80x24 で、実サイズを決める最初の fit は
    // spawn の await が解ける前に走る。await の後で購読すると、その1回きりの
    // 通知を誰も受け取れず、fit は変化時しか発火しないので二度と再送されない
    // （= PTY が 80x24 のまま固定され、狭いペインで TUI が崩れる）
    const resizeSub = this.term.onResize(({ cols, rows }) => {
      requestResize(this.id, cols, rows);
    });
    this.disposables.push(resizeSub);

    const visibleAtSpawn = !this.ws.layer.hidden;
    const spawnShell = this.resumed ? this.spec.resumeShell ?? this.spec.shell : this.spec.shell;
    const spawnArgs = this.resumed ? this.spec.resumeArgs ?? this.spec.args : this.spec.args;
    let configuredSpawn = true;
    let spawned = false;
    try {
      spawned = await this.spawnPty(
        spawnShell ?? shellForKind(this.ws.shellKind) ?? null,
        spawnArgs ?? null,
        this.spec.cwd ?? null,
        visibleAtSpawn,
      );
    } catch (error) {
      // 保存済みの shell / args が使えない、設定シェルが消えた等でも、表示履歴だけの
      // 入力不能ペインを残さない。通常の対話シェルへ退避し、打鍵はゲートで保持する。
      configuredSpawn = false;
      this.activityEngaged = false;
      this.activityReady = false;
      this.bracketedPaste = undefined;
      console.error(`pty_spawn failed (pane ${this.id}); falling back to an interactive shell:`, error);
      this.term.write(`${INTERACTIVE_MODE_RESET}\r\n\x1b[2m── ${t("pane.restarting")} ──\x1b[0m\r\n`);
      spawned = await this.spawnInteractiveShell();
    } finally {
      spawnDone();
    }

    if (!spawned) return; // destroy と競合した場合だけ

    // spawn 中に保持していたサイズをここで解禁する。await の間に layout() が
    // 走っていれば実サイズが、走っていなければ 80x24 が入っており、
    // 後者は Rust 側の重複排除で no-op になる
    markSpawned(this.id);
    requestResize(this.id, this.term.cols, this.term.rows);
    this.alive = true;
    this.el.classList.remove("is-dead");

    // pty_spawn と setActive の pty_set_visible は並行に走るため、spawn の
    // 登録完了前に届いた可視化通知は Rust 側で捨てられる（未登録 id は無視）。
    // 新規セッションの初期ペインはこのレースで非表示のまま固定され、
    // プロンプトもエコーも画面に出ない。spawn 後に現在の可視状態を送り直す
    const visibleNow = !this.ws.layer.hidden;
    if (visibleNow !== visibleAtSpawn) {
      void invoke("pty_set_visible", { ids: [this.id], visible: visibleNow });
    }

    // 復元時は「検知済みエージェントの再開（--resume <id> 等）」を最優先にし、
    // 無ければ従来どおり resumeRun → run。直接起動ペイン（resumeShell）は
    // プロセス自体が再開起動なので、その stdin へコマンドを流し込まない。
    // エージェント自動引き継ぎはソフトロック対象（Locked 中は注入しない。
    // resumeRun / run は復元・Issue 実行の基本動作なので無料枠のまま）
    const agentCmd =
      this.resumed && !this.spec.resumeShell && !isLocked()
        ? resumeCommandFor(this.spec.agent)
        : null;
    const cmd = agentCmd ?? (this.resumed ? this.spec.resumeRun ?? this.spec.run : this.spec.run);
    if (configuredSpawn && cmd) {
      // プロンプトが出る前に流すと食われるので少し待つ
      // claude / codex を立ち上げるだけでは作業中にしない。実際の依頼はユーザーの打鍵か
      // ペアモードの writeAndWait で activity を開始する。
      setTimeout(() => {
        this.startupRunSent = true;
        this.write(`${cmd}\r`, false);
      }, 400);
    }
  }

  /** PTY 出力用 Channel を起動ごとに作る。終了後の再起動でも同じ xterm へ接続する。 */
  private outputChannel(): Channel<string> {
    const onData = new Channel<string>();
    onData.onmessage = (data) => {
      if (this.destroyed) return;
      diag.echo += data.length;
      this.term.write(data);
      this.snapshotDirty = true;
    };
    return onData;
  }

  /** 1回の PTY 起動。destroy と競合した場合は、起動直後に必ず回収する。 */
  private async spawnPty(
    shell: string | null,
    args: string[] | null,
    cwd: string | null,
    visible = !this.ws.layer.hidden,
  ): Promise<boolean> {
    await invoke("pty_spawn", {
      id: this.id,
      cols: this.term.cols,
      rows: this.term.rows,
      shell,
      args,
      cwd,
      visible,
      onData: this.outputChannel(),
    });
    if (!this.destroyed) return true;
    // close / restartPane が spawn の await 中に走った場合の孤児プロセスを残さない。
    await invoke("pty_kill", { id: this.id }).catch(() => {});
    return false;
  }

  /**
   * 必ず対話可能なシェルへ退避する。
   *
   * まず OS の既定シェルを現在 cwd で試し、それも起動できなければ OS 標準の
   * 最小シェルを安全な cwd で試す。環境の一時的な失敗中も1秒間隔で再試行し、
   * ペインを「表示だけで入力先が無い」状態に固定しない。
   */
  private async spawnInteractiveShell(): Promise<boolean> {
    const emergency = emergencyShell();
    while (!this.destroyed) {
      const candidates = [
        { shell: null, args: null, cwd: this.cwd ?? this.spec.cwd ?? null },
        { shell: emergency.shell, args: emergency.args, cwd: null },
      ];
      for (const candidate of candidates) {
        try {
          if (await this.spawnPty(candidate.shell, candidate.args, candidate.cwd)) return true;
          return false;
        } catch (error) {
          console.error(`interactive shell fallback failed (pane ${this.id}):`, error);
        }
      }
      await retryDelay(1000);
    }
    return false;
  }

  /** 新しい打鍵を、復旧した PTY の spawn 完了まで既存の直列化キューで保持する。 */
  private holdWrites(): () => void {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.writeChain = this.writeChain.then(() => gate);
    return release;
  }

  /**
   * 子プロセス終了後も同じペインを対話シェルとして生かし続ける。
   * `exit` や異常終了で入力不能の画面を残さないため、activity.ts の pty:exit から呼ぶ。
   */
  recoverFromExit() {
    if (this.destroyed || this.recovering) return;
    this.recovering = true;
    this.alive = false;
    this.activityEngaged = false;
    this.activityReady = false;
    this.startupRunSent = false;
    this.bracketedPaste = undefined;
    this.bellPending = false;
    this.el.classList.add("is-dead");
    this.term.write(`${INTERACTIVE_MODE_RESET}\r\n\x1b[2m── ${t("pane.restarting")} ──\x1b[0m\r\n`);
    const releaseWrites = this.holdWrites();
    void (async () => {
      try {
        if (!(await this.spawnInteractiveShell())) return;
        markSpawned(this.id);
        requestResize(this.id, this.term.cols, this.term.rows);
        this.alive = true;
        this.el.classList.remove("is-dead");
        if (this.id === getFocusedId()) this.focus();
      } finally {
        releaseWrites();
        this.recovering = false;
      }
    })();
  }

  private outBuf = "";
  private outTimer?: number;
  /** writeAndWait の解決関数。次のフラッシュの pty_write 完了でまとめて resolve する */
  private flushWaiters: (() => void)[] = [];

  /** キー入力を順序保証つきで PTY に送る。
      キーイベントのハンドラ内から同期的に IPC (postMessage) を呼ぶと、
      WKWebView のキー配送（UIプロセスとの同期往復）と競合して次の打鍵を
      取りこぼすことがあるため、タスクを分けてから送る。 */
  write(data: string, marksActivity = true) {
    this.enqueue(data, marksActivity);
  }

  /** write と同じ直列化キューに積み、そのデータの pty_write 完了（失敗含む）で解決する。
      ペアモードが「貼り付けが PTY へ届いてから Enter を別送する」ために使う。
      reject はしない（失敗時のリカバリは呼び出し側のウォッチドッグの役目） */
  writeAndWait(data: string, marksActivity = true): Promise<void> {
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      this.enqueue(data, marksActivity);
    });
  }

  private enqueue(data: string, marksActivity: boolean) {
    if (marksActivity) {
      this.activityEngaged = true;
      this.activityReady = true;
      this.busy = true;
      updateWsActivity(this.ws);
    }
    this.outBuf += data;
    if (this.outTimer !== undefined) return;
    this.outTimer = window.setTimeout(() => {
      this.outTimer = undefined;
      const chunk = this.outBuf;
      this.outBuf = "";
      // 待ち手はこのフラッシュに含まれた分を取り切る（次のフラッシュへ持ち越さない）
      const waiters = this.flushWaiters;
      this.flushWaiters = [];
      if (!chunk) {
        for (const w of waiters) w();
        return;
      }
      diag.sent += chunk.length;
      this.writeChain = this.writeChain.then(async () => {
        try {
          await invoke("pty_write", { id: this.id, data: chunk });
          diag.ok += chunk.length;
        } catch (e) {
          diag.err += chunk.length;
          diagPush(`werr:${String(e).slice(0, 80)}`);
          console.error(`pty_write failed (pane ${this.id}):`, e);
        } finally {
          for (const w of waiters) w();
        }
      });
    }, 0);
  }

  /** dirty ならスナップショットを取り直してキャッシュする。アイドル時間に呼ぶこと
      （SerializeAddon の直列化は同期処理で、大きいスクロールバックでは数十msかかる） */
  refreshSnapshot() {
    if (!this.snapshotDirty) return;
    try {
      // session.json は「表示履歴」だけを持つ。TUI の alternate buffer や入力モードを
      // 復元すると、新しいシェルまで application cursor / mouse 等を引き継いでしまう。
      const s = this.serializer.serialize({
        scrollback: SNAPSHOT_LINES,
        excludeModes: true,
        excludeAltBuffer: true,
      });
      this.snapshotCache = s || undefined;
      this.snapshotDirty = false;
    } catch {
      /* dispose 済み等。前回のキャッシュを使い続ける */
    }
  }

  /** 保存用のスクロールバックスナップショット（ANSI込み、直近 SNAPSHOT_LINES 行）。
      基本はキャッシュを返すだけ（多少古くてもよい）。キャッシュが無い初回のみ同期で取る。 */
  snapshot(): string | undefined {
    if (this.snapshotCache === undefined && this.snapshotDirty) {
      try {
        const s = this.serializer.serialize({
          scrollback: SNAPSHOT_LINES,
          excludeModes: true,
          excludeAltBuffer: true,
        });
        this.snapshotCache = s || undefined;
        this.snapshotDirty = false;
      } catch {
        /* dispose 済み等 */
      }
    }
    return this.snapshotCache;
  }

  setRect(r: Rect) {
    this.el.style.left = `${r.x}px`;
    this.el.style.top = `${r.y}px`;
    this.el.style.width = `${r.w}px`;
    this.el.style.height = `${r.h}px`;
  }

  /** ResizeObserver からの再フィットを rAF 1本に束ねる */
  private scheduleRefit() {
    if (this.refitRaf) return;
    this.refitRaf = requestAnimationFrame(() => {
      this.refitRaf = 0;
      this.refit();
    });
  }

  refit() {
    try {
      // **退化サイズで fit させない。** FitAddon は要素が DOM に付いていて 0px の
      // ときは undefined を返さず、Math.max(2, …) / Math.max(1, …) で 2x1 を返す。
      // そのまま fit すると term.resize(2,1) が走ってバッファが2桁に折り返され、
      // PTY まで 2x1 になる（最小化・最大化・スナップで一瞬 0 になると起きる）。
      // 元のサイズに戻しても折り返しは戻らないので、TUI は再起動するまで壊れたまま。
      // スキップしても ResizeObserver が箱の確定後に呼び直す
      const dims = this.fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
      if (dims.cols < MIN_FIT_COLS || dims.rows < MIN_FIT_ROWS) return;
      if (this.el.clientWidth <= 0 || this.el.clientHeight <= 0) return;
      this.fit.fit();
      // Files / サイドバーの開閉やセッション再表示で横幅が変わると、WebKit は
      // xterm の resize 後に viewport の scrollTop を先頭へ戻すことがある。
      // ターミナルは通常最新出力を見る UI なので、レイアウト変更後は末尾へ固定する。
      // 同期呼び出しだけでは後続のブラウザリフローに負けるため、次フレームでも再適用する。
      this.scrollToBottom();
      // ペイン生成直後は要素が 0x0（レイアウト前）。その状態で WebGL を
      // 初期化すると描画が壊れたまま復帰しないことがあるため、
      // サイズが確定した最初の refit で遅延ロードする。
      if (!this.webglLoaded) {
        this.webglLoaded = true;
        try {
          const webgl = new WebglAddon();
          // ペイン数がブラウザの WebGL コンテキスト上限（~16）を超えると
          // 古いコンテキストから失われる。放置すると描画が壊れたままになるので
          // DOM レンダラに退避する。退避しただけでは画面が古いままなので
          // 描き直しと再フィットまでやる。
          webgl.onContextLoss(() => {
            webgl.dispose();
            this.term.refresh(0, this.term.rows - 1);
            this.scheduleRefit();
          });
          this.term.loadAddon(webgl);
        } catch {
          // WebGL 不可の環境では DOM 描画にフォールバック。動作に支障なし。
        }
      }
    } catch {
      /* レイアウト確定前は寸法が取れないことがある */
    }
  }

  /** xterm の buffer と DOM viewport を同じタイミングで末尾へ合わせる。
      buffer が既に末尾だと term.scrollToBottom() は何もしないため、WebKit だけが
      DOM scrollTop を先頭へ動かした直後は viewport も明示的に戻す必要がある。 */
  private applyBottomScroll() {
    this.term.scrollToBottom();
    const viewport = this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }

  /** xterm の buffer と DOM viewport を、focus 前に見ていた位置へ戻す。
      DOM scrollTop は行高から再計算せず記録値をそのまま使う（focus 前後で行高は変わらない）。 */
  private applyScrollPosition(line: number, top: number) {
    this.term.scrollToLine(line);
    const viewport = this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    if (viewport) viewport.scrollTop = top;
  }

  /** 同期と次フレームの両方で同じスクロール補正を当てる（WebKit の遅延リフロー対策）。
      後から要求された補正が勝つ。 */
  private applyScrollTwice(apply: () => void) {
    if (this.destroyed) return;
    apply();
    if (this.scrollBottomRaf) cancelAnimationFrame(this.scrollBottomRaf);
    this.scrollBottomRaf = requestAnimationFrame(() => {
      this.scrollBottomRaf = 0;
      if (!this.destroyed) apply();
    });
  }

  /** レイアウト直後と WebKit の遅延リフロー後の両方で末尾へ合わせる。 */
  scrollToBottom() {
    this.applyScrollTwice(() => this.applyBottomScroll());
  }

  focus() {
    // xterm は textarea.focus({ preventScroll: true }) を使うが、WKWebView は
    // ペイン間のフォーカス移動時にそれを無視し、viewport の DOM scrollTop を
    // 先頭へ戻すことがある。scroll イベントで buffer.ydisp まで先頭へ変わる前と
    // 次フレームの両方で補正する。
    // **末尾へ飛ばすのではなく focus 前の位置へ戻す。** ペイン内クリックも
    // mousedown → setFocused → focus() を通るので、末尾固定にすると履歴を遡って
    // 読んでいる最中のクリックや、Cmd/Ctrl+クリックで URL を開く操作
    // （mousedown で buffer が動くと mouseup 時にリンクから外れて発火しない）が壊れる。
    // 末尾を見ていたときだけ従来どおり scrollToBottom() で末尾追従を保つ。
    const buffer = this.term.buffer.active;
    const atBottom = buffer.viewportY >= buffer.baseY;
    const line = buffer.viewportY;
    const viewport = this.term.element?.querySelector<HTMLElement>(".xterm-viewport");
    const top = viewport?.scrollTop ?? 0;
    this.term.focus();
    if (atBottom) this.scrollToBottom();
    else this.applyScrollTwice(() => this.applyScrollPosition(line, top));
  }

  /** メモ本文と表示先を同期する。全文は省略時も title から確認できる。 */
  setWorkspaceNote(note: string | undefined, first: boolean) {
    const value = note ?? "";
    this.noteEl.textContent = value;
    this.noteEl.title = value;
    this.noteEl.hidden = !first || !value;
  }

  async destroy() {
    this.destroyed = true;
    this.alive = false;
    this.ws.panes.delete(this.id);
    panes.delete(this.id);
    unregisterPane(this.id);
    this.ro?.disconnect();
    if (this.refitRaf) cancelAnimationFrame(this.refitRaf);
    if (this.scrollBottomRaf) cancelAnimationFrame(this.scrollBottomRaf);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    // spawn / 自動復旧との競合時も必ず回収する（未登録 id は Rust 側で no-op）。
    await invoke("pty_kill", { id: this.id }).catch(() => {});
    this.term.dispose();
    this.el.remove();
  }
}

export function makePane(ws: Workspace, spec: PaneSpec, opts: { scrollback?: string; resumed?: boolean } = {}): Pane {
  const pane = new Pane(ws, spec, opts);
  ws.panes.set(pane.id, pane);
  panes.set(pane.id, pane);
  ws.layer.append(pane.el);
  return pane;
}
