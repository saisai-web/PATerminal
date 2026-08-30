// ============================================================
// ペアモード（2つのエージェントペインの相互セッション）
//
// 1セッション内の2ペイン（A / B）を組み、片方の出力（画面末尾のキャプチャや
// 実装役の git diff）を次のプロンプトとして相方へ受け渡す。モードは4つ:
//
// - implement（実装 × レビュー）: A が実装し、静止するたび B が diff を
//   レビューして指摘を返す。従来のペアモードそのもの。
//   「あとづけ」配置（attach）では作業途中のフォーカス中ペインを A にして
//   B を後から分割で足し、B の起動直後に最初のレビューを依頼する
// - cross（クロスレビュー）: A / B が同じ変更を独立にレビューし、
//   両方が静止するたび指摘を交換（バリア同期）。指定回数の突き合わせ後、
//   A が1本の統合リストへまとめて完了。どちらもファイルは編集しない
// - brainstorm（ブレスト）: お題について A → B → A … と意見交換し、
//   指定回数後に A がまとめて完了。完了後は「実装へ進む」で coop の
//   分担フェーズへ昇格できる（同じ2ペインのまま、会話文脈を保持）
// - coop（ブレスト → 共同実装）: ブレスト後、A が作業をファイル単位で
//   重ならない2人分に分担し、両方が同時に実装。区切りごとに進捗を交換
//   （同期）し、指定回数後に A が仕上げて完了
//
// **受け渡しのトリガーは3層**:
// 1. **完了シグナル（最優先・全フェーズ自動）**: ペアが自分で claude / codex を
//    起動する経路（replace / new の両ペイン、attach のレビュー役）では、起動
//    コマンドに CLI 公式の完了フック（claude: --settings で Stop フック /
//    codex: -c notify= で agent-turn-complete）を注入する。エージェント自身が
//    ターン完了を通知するので誤発火も不発も無く、シグナル管理ペインは実装側・
//    返答側とも agent:turn（Rust の agents/signal.rs が配送）だけで自動で回す。
//    ペア自身が送ったプロンプトのターンだけ消費する（pendingTurn ゲート）
// 2. **静止検知（シグナルが無いペインの返答側のみ）**: TUI の「実装完了」は
//    出力の静止（pty:act の busy→idle）から確実には判定できない（思考待ちの
//    沈黙で誤発火し、静止の来ない進み方をする codex では不発）ため、静止検知で
//    自動にするのは返答の転送だけ: レビュー役→実装役のフィードバック返送 /
//    ブレストのピンポン / cross のバリア交換 / merge・summary の完了 / 起動待ち
// 3. **手動ボタン（常設の保険）**: 実装完了の判定が要る受け渡し（implement の
//    実装役→レビュー依頼 / coop 同時実装の同期・仕上げ / wrapUp と実装ラウンド
//    上限の完了判定）は、シグナルが無ければストリップの受け渡しボタン
//    （#pair-handoff）でユーザーが行う。ボタンは全フェーズで常設され、押せば
//    自動と同じ処理をその場で実行する（ラベルはフェーズで変わる）
//
// implement のレビュー依頼は「レビュー役が自分のシェルの cwd で git diff を
// 見る」方式ではなく、実装役の cwd（pty_cwd）から取った git_summary /
// git_worktree_diff の結果をボタン押下時に確定させてから diff テキストとして
// 埋め込んで送る。レビュー役のシェルが別ディレクトリに cd していても正しい
// 対象を見せられる（かつ未コミットの変更が無ければレビューへ渡さず
// ラウンドも消費しない）。cross / coop は両ペインをセッションの cwd で
// 起動する前提で、プロンプト内で `git diff HEAD` を自走させる
//
// - このアプリで唯一「Enter まで自動送信する」機能。ペアとして明示的に
//   組んだ2ペインのスコープに閉じ、それ以外の入力経路（定型文・画像パス等）の
//   「入力のみ・実行しない」方針は変えない
// - waiting（承認ダイアログ等）で静止したときは自動送信せず表示だけ切り替え、
//   ユーザーが応答して次に静止したところから再開する
// - 状態はランタイムのみ（session.json に保存しない）。ペアを止めても
//   エージェントのプロセスには触らない
// ============================================================

import { invoke } from "@tauri-apps/api/core";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { t, type MsgKey } from "../../i18n";
import { requireFeature } from "../license/license";
import { getGitRoot } from "../git/agent-panel";
import type { WorktreeList } from "../git/worktree";
import { openQuickPhrasesFor } from "../quick-phrases/quick-phrases";
import { getActiveWs, getFocusedId, getHostOs, workspaces } from "../../workspace/state";
import type { Pane } from "../../terminal/pane";
import type { Workspace } from "../../workspace/types";

type PairDeps = {
  /** ペアストリップ（帯）の表示/非表示が変わったときの再レイアウト（refit 必須） */
  layout: () => void;
  /** 新しいペアセッション（左右2ペイン + それぞれの起動コマンド）を作る。
      戻りは [Aペイン, Bペイン] */
  createPairSession: (opts: { implCmd: string; reviewCmd: string; cwd?: string }) => Promise<[Pane, Pane]>;
  /** 表示中セッションの中にペアの2ペインを作り、元からあったペインを閉じる
      （セッション名・位置・グループは維持）。await 中にセッションが閉じられたら null */
  replacePanesWithPair: (opts: { implCmd: string; reviewCmd: string }) => Promise<[Pane, Pane] | null>;
  /** あとづけレビュー: 実装役ペインの隣にレビュー役ペインを分割で作る
      （cwd は実装役のシェルの実 cwd を引き継ぐ）。await 中に消えたら null */
  addReviewerPane: (opts: { impl: Pane; cmd: string }) => Promise<Pane | null>;
  /** あとづけレビューの実装役 = フォーカス中ペイン */
  getFocusedPane: () => Pane | null;
  /** モーダルを閉じるときにターミナルへフォーカスを返す */
  focusTerminal: () => void;
};

/** ペアの種類（何をさせるか）。placement（どう組むか）とは独立 */
type PairKind = "implement" | "cross" | "brainstorm" | "coop";
/** ブレストの議論スタイル。critic は B が批判役に回る */
type BrainStyle = "yesAnd" | "critic";

type PairPhase =
  /** replace / new: A の起動待ち。最初の静止で初回プロンプトを送り afterStart へ */
  | "starting"
  /** あとづけ: B（レビュー役）の起動待ち。起動したら即レビューへ */
  | "attaching"
  /** implement: A の作業中。静止したらレビュー依頼を送る（ラウンド上限なら完了） */
  | "implTurn"
  /** implement: B の作業中。静止したら画面末尾を A へ返す */
  | "reviewTurn"
  /** brainstorm / coop の議論: A の番。静止したらキャプチャを B へ */
  | "aTurn"
  /** brainstorm / coop の議論: B の番。静止したらキャプチャを A へ */
  | "bTurn"
  /** coop: A が分担表を作成中。静止したら両方へ着手指示 */
  | "plan"
  /** cross の同時レビュー / coop の同時実装。両方が静止したときだけ交換（バリア） */
  | "bothWorking"
  /** cross: A が統合リストを作成中。静止で完了 */
  | "merge"
  /** brainstorm: A がまとめを作成中。静止で完了 */
  | "summary"
  /** coop: A が仕上げ中。静止で完了 */
  | "wrapUp"
  | "done";

/** bothWorking（バリア）のペイン別フラグ。busy 再開で idleSeen を取り消し、
    交換時にまとめてリセットする */
type SideFlags = { seeded: boolean; hadBusy: boolean; idleSeen: boolean };

type PairState = {
  ws: Workspace;
  /** A = 実装役 / レビューA / 発案役。統合・まとめ・分担も A が担当する */
  aId: string;
  /** B = レビュー役 / レビューB / 相方 */
  bId: string;
  kind: PairKind;
  style: BrainStyle;
  maxRounds: number;
  /** 送信済みの受け渡し数（implement: レビュー依頼 / cross: 突き合わせ /
      brainstorm・coop: A→B のハンドオフ） */
  round: number;
  /** coop の実装フェーズの同期回数（上限と実績。ブレスト側の round とは別勘定） */
  maxSync: number;
  syncCount: number;
  /** coop で分担フェーズ以降に入ったか（チップ表示とラウンド±の対象切替に使う） */
  building: boolean;
  phase: PairPhase;
  /** starting の静止後に入るフェーズ（implement: implTurn / brainstorm・coop: aTurn） */
  afterStart: "implTurn" | "aTurn";
  paused: boolean;
  /** waiting（承認ダイアログ等）で静止中。表示のみで、応答後の静止から自動再開する */
  awaitingUser: boolean;
  /** 受け渡しボタンの diff 取得 await 中（二度押し防止で disabled にする） */
  handoffBusy: boolean;
  /** 直近の受け渡し操作の補足（変更なしで渡せなかった等）。次の操作・遷移で消す */
  noteKey?: MsgKey;
  /** starting フェーズで A へ送る初回プロンプト */
  pendingTask?: string;
  /** bothWorking の起動待ち中に各ペインへ配るプロンプト（cross の replace / new） */
  seedText?: string;
  /** implement: レビュー依頼へ添えるユーザーの観点（あとづけの入力欄） */
  reviewFocus?: string;
  sideA: SideFlags;
  sideB: SideFlags;
  /** 自然完了か（ペイン終了による中断と区別。ブレストの「実装へ進む」の表示条件） */
  finished: boolean;
  /** done のときに表示する終了理由 */
  endMessage?: string;
  /** submit 送信済みで、まだ実働（busyMs >= MIN_TURN_MS の活動）を確認できていない
      ペイン。次の静止が短い（貼り付けエコーの描画だけ = Enter が飲まれた）なら
      Enter を再送する */
  pendingSubmits: Map<string, { retries: number }>;
  /** ペア自身が paste + submit してまだ完了シグナルを消費していないペイン。
      ユーザーが手で打った割り込みターンの完了フックで誤受け渡ししないためのゲート
      （シグナル管理ペインの agent:turn はこの集合にあるときだけ消費する） */
  pendingTurn: Set<string>;
  /** 静止の再確認タイマー（ペイン別）。busy 再開・一時停止・終了で破棄する */
  idleTimers: Map<string, number>;
};

/** 実装役 / レビュー役の既定起動コマンド。設定パネルで入れ替え・変更でき、
    session.json の settings.pair に保存する（セットアップモーダルを開くたびに
    フィールドへ反映する。worktree の prefs と同じ「開くたびに現在値へ同期」方式） */
export type PairDefaultCmds = { implCmd: string; reviewCmd: string };
const DEFAULT_PAIR_CMDS: PairDefaultCmds = { implCmd: "claude", reviewCmd: "codex" };
let pairDefaultCmds: PairDefaultCmds = { ...DEFAULT_PAIR_CMDS };

export function getPairDefaultCmds(): PairDefaultCmds {
  return { ...pairDefaultCmds };
}

/** session.json からの復元用。壊れた値・空文字は既定へ落とす（マイグレーションは書かない） */
export function setPairDefaultCmds(value: unknown): void {
  const saved = (value ?? {}) as Partial<Record<keyof PairDefaultCmds, unknown>>;
  const cmd = (v: unknown, fallback: string) => {
    const n = typeof v === "string" ? normalizeCmd(v) : "";
    return n || fallback;
  };
  pairDefaultCmds = {
    implCmd: cmd(saved.implCmd, DEFAULT_PAIR_CMDS.implCmd),
    reviewCmd: cmd(saved.reviewCmd, DEFAULT_PAIR_CMDS.reviewCmd),
  };
}

/** 設定パネルからの変更。空・制御文字だけの値は無視して直前の値を保つ
    （保存は呼び出し側の scheduleSave に任せる） */
export function updatePairDefaultCmds(patch: Partial<PairDefaultCmds>): void {
  const next = { ...pairDefaultCmds };
  if (patch.implCmd !== undefined) {
    const v = normalizeCmd(patch.implCmd);
    if (v) next.implCmd = v;
  }
  if (patch.reviewCmd !== undefined) {
    const v = normalizeCmd(patch.reviewCmd);
    if (v) next.reviewCmd = v;
  }
  pairDefaultCmds = next;
}

/** 打鍵エコーやプロンプト再描画だけの短い活動ではターンを回さない */
const MIN_TURN_MS = 3000;
/** 貼り付けから Enter までの間隔。TUI がペーストを取り込む猶予
    （pty_write の完了を待ってから数える） */
const ENTER_DELAY_MS = 250;
/** Enter が TUI に飲まれた（送信後の静止が描画だけで実働が無い）ときの再送上限 */
const SUBMIT_MAX_RETRIES = 2;
/** 静止（ACT_IDLE = 2秒の無出力）を「ターン完了」と確定するまでの再確認待ち。
    モデルの思考待ちや無出力ツール実行の一時的な沈黙で中途半端な作業を
    受け渡さないための猶予。この間に出力が再開したら取り消す */
const HANDOFF_CONFIRM_MS =
  (window as { __pairTuning?: { handoffConfirmMs?: number } }).__pairTuning?.handoffConfirmMs ??
  6000;
/** 画面末尾のキャプチャ上限（TUI の枠などのノイズ込みで渡す） */
const CAPTURE_MAX_LINES = 120;
const CAPTURE_MAX_CHARS = 6000;
/** レビュー依頼へ埋め込む diff の上限（先頭から切り詰め） */
const DIFF_MAX_CHARS = 20000;
export const PAIR_MAX_ROUNDS = 10;
/** モード別のラウンド既定値（モード切替時にフォームへ反映する） */
const KIND_DEFAULT_ROUNDS: Record<PairKind, number> = {
  implement: 2,
  cross: 1,
  brainstorm: 3,
  coop: 2,
};
/** coop の同期回数の既定（ブレストからの昇格時にも使う） */
const DEFAULT_SYNC_ROUNDS = 2;

/** wsId → ペア状態。1セッションにつき1ペアだけ */
const pairs = new Map<string, PairState>();
let deps: PairDeps | null = null;

// ------------------------------------------------------------
// ターン完了シグナル（エージェント CLI の公式完了フックを起動時に注入する）
//
// ペアが自分でエージェントを起動する経路（replace / new の両ペイン、attach の
// レビュー役）では、claude の Stop フック / codex の notify=agent-turn-complete を
// 注入し、Rust（agents/signal.rs）の監視が `agent:turn { token }` として届ける。
// シグナルが取れるペインは静止検知ではなくこれで全フェーズを自動で回す。
// 注入できないペイン（既存ペイン・未知のエージェント・Windows）は従来どおり
// 手動ボタン + 返し側の静止検知へ退化する
// ------------------------------------------------------------

/** token → 対象ペイン。endPair / stopPair / セッション回収で解除する */
const signalTokens = new Map<string, { wsId: string; paneId: string }>();
/** paneId → token の逆引き（シグナル管理ペインの判定に使う） */
const paneSignalTokens = new Map<string, string>();
/** agent_signal_init が返したシグナルディレクトリ（初期化失敗・Windows は null） */
let signalDirPromise: Promise<string | null> | null = null;

/** シグナルディレクトリを1回だけ用意する（Rust がフックファイル生成 + 監視開始）。
    Windows は注入構文が別物なので今回は対象外（null = 注入なしで続行） */
function ensureSignalDir(): Promise<string | null> {
  const os = getHostOs();
  if (os !== "macos" && os !== "linux") return Promise.resolve(null);
  signalDirPromise ??= invoke<string>("agent_signal_init").catch(() => null);
  return signalDirPromise;
}

/** POSIX シェル向けの ' 引用 */
function quotePosix(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 起動コマンドへ完了シグナルの注入を前置する。対象は先頭トークンが claude / codex の
    コマンドだけで、既に `--settings` / `notify=` を持つものは触らない。
    対象外は null（素のコマンドで起動し、シグナル管理にもしない） */
function withCompletionSignal(cmd: string, token: string, dir: string): string | null {
  const trimmed = cmd.trim();
  const first = trimmed.split(/\s+/, 1)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  const rest = trimmed.slice(first.length);
  // fish は VAR=v cmd の前置代入を解釈しないので、全シェル共通の env(1) を使う
  const envPrefix = `env PATERM_PAIR_SIGNAL=${quotePosix(`${dir}/${token}`)}`;
  if (base === "claude") {
    if (trimmed.includes("--settings")) return null;
    return `${envPrefix} ${first} --settings ${quotePosix(`${dir}/claude-stop-hook.json`)}${rest}`;
  }
  if (base === "codex") {
    if (/\bnotify\s*=/.test(trimmed)) return null;
    return `${envPrefix} ${first} -c ${quotePosix(`notify=["${dir}/notify.sh"]`)}${rest}`;
  }
  return null;
}

function registerPairSignal(token: string, pane: Pane) {
  signalTokens.set(token, { wsId: pane.ws.id, paneId: pane.id });
  paneSignalTokens.set(pane.id, token);
}

/** ペアの両ペインのシグナル登録を解除する（迷子のシグナルは Map に無いので無視される） */
function releasePairSignals(st: PairState) {
  for (const id of [st.aId, st.bId]) {
    const token = paneSignalTokens.get(id);
    if (token !== undefined) {
      paneSignalTokens.delete(id);
      signalTokens.delete(token);
    }
  }
}

const openBtn = document.querySelector<HTMLButtonElement>("#pair-open")!;
const openLabelEl = document.querySelector<HTMLSpanElement>("#pair-open-label")!;
const stripEl = document.querySelector<HTMLDivElement>("#pair-strip")!;
const stripNameEl = document.querySelector<HTMLSpanElement>("#pair-strip-name")!;
const aChipEl = document.querySelector<HTMLSpanElement>("#pair-chip-impl")!;
const arrowEl = document.querySelector<HTMLSpanElement>("#pair-arrow")!;
const bChipEl = document.querySelector<HTMLSpanElement>("#pair-chip-review")!;
const roundEl = document.querySelector<HTMLSpanElement>("#pair-strip-round")!;
const roundDecBtn = document.querySelector<HTMLButtonElement>("#pair-round-dec")!;
const roundIncBtn = document.querySelector<HTMLButtonElement>("#pair-round-inc")!;
const statusEl = document.querySelector<HTMLSpanElement>("#pair-strip-status")!;
const turnBackBtn = document.querySelector<HTMLButtonElement>("#pair-turn-back")!;
const promoteBtn = document.querySelector<HTMLButtonElement>("#pair-promote")!;
const pauseBtn = document.querySelector<HTMLButtonElement>("#pair-pause")!;
const stopBtn = document.querySelector<HTMLButtonElement>("#pair-stop")!;
const overlay = document.querySelector<HTMLDivElement>("#pair-overlay")!;
const panel = document.querySelector<HTMLDivElement>("#pair-panel")!;
const closeBtn = document.querySelector<HTMLButtonElement>("#pair-close")!;
const runningEl = document.querySelector<HTMLDivElement>("#pair-running")!;
const runningTextEl = document.querySelector<HTMLSpanElement>("#pair-running-text")!;
const modalStopBtn = document.querySelector<HTMLButtonElement>("#pair-modal-stop")!;
const form = document.querySelector<HTMLFormElement>("#pair-form")!;
const kindImplementRadio = document.querySelector<HTMLInputElement>("#pair-kind-implement")!;
const kindCrossRadio = document.querySelector<HTMLInputElement>("#pair-kind-cross")!;
const kindBrainstormRadio = document.querySelector<HTMLInputElement>("#pair-kind-brainstorm")!;
const kindCoopRadio = document.querySelector<HTMLInputElement>("#pair-kind-coop")!;
const modeReplaceRadio = document.querySelector<HTMLInputElement>("#pair-mode-replace")!;
const modeCurrentRadio = document.querySelector<HTMLInputElement>("#pair-mode-current")!;
const modeNewRadio = document.querySelector<HTMLInputElement>("#pair-mode-new")!;
const modeAttachRadio = document.querySelector<HTMLInputElement>("#pair-mode-attach")!;
const modeAttachWrap = document.querySelector<HTMLLabelElement>("#pair-mode-attach-wrap")!;
const currentFieldsEl = document.querySelector<HTMLDivElement>("#pair-current-fields")!;
const newFieldsEl = document.querySelector<HTMLDivElement>("#pair-new-fields")!;
const implPaneSel = document.querySelector<HTMLSelectElement>("#pair-impl-pane")!;
const reviewPaneSel = document.querySelector<HTMLSelectElement>("#pair-review-pane")!;
const implPaneLabel = document.querySelector<HTMLSpanElement>("#pair-impl-pane-label")!;
const reviewPaneLabel = document.querySelector<HTMLSpanElement>("#pair-review-pane-label")!;
const implCmdInput = document.querySelector<HTMLInputElement>("#pair-impl-cmd")!;
const reviewCmdInput = document.querySelector<HTMLInputElement>("#pair-review-cmd")!;
const newCwdFieldEl = document.querySelector<HTMLDivElement>("#pair-new-cwd-field")!;
const newWorktreeSel = document.querySelector<HTMLSelectElement>("#pair-new-worktree")!;
const newCwdInput = document.querySelector<HTMLInputElement>("#pair-new-cwd")!;
const newCwdBrowseBtn = document.querySelector<HTMLButtonElement>("#pair-new-cwd-browse")!;
const implCmdField = document.querySelector<HTMLLabelElement>("#pair-impl-cmd-field")!;
const implCmdLabel = document.querySelector<HTMLSpanElement>("#pair-impl-cmd-label")!;
const reviewCmdLabel = document.querySelector<HTMLSpanElement>("#pair-review-cmd-label")!;
const roundsInput = document.querySelector<HTMLInputElement>("#pair-rounds")!;
const roundsLabel = document.querySelector<HTMLSpanElement>("#pair-rounds-label")!;
const syncInput = document.querySelector<HTMLInputElement>("#pair-sync")!;
const syncField = document.querySelector<HTMLLabelElement>("#pair-sync-field")!;
const styleField = document.querySelector<HTMLDivElement>("#pair-style-field")!;
const styleYesAndRadio = document.querySelector<HTMLInputElement>("#pair-style-yesand")!;
const styleCriticRadio = document.querySelector<HTMLInputElement>("#pair-style-critic")!;
const taskInput = document.querySelector<HTMLTextAreaElement>("#pair-task")!;
const taskLabel = document.querySelector<HTMLSpanElement>("#pair-task-label")!;
const taskQuickBtn = document.querySelector<HTMLButtonElement>("#pair-task-quick")!;
const errorEl = document.querySelector<HTMLDivElement>("#pair-error")!;
const handoffBtn = document.querySelector<HTMLButtonElement>("#pair-handoff")!;
let startingPair = false;

let worktreeLoadToken = 0;

/** active session の cwd を、フォームを開いた直後の初期値として使う。 */
function pairCwdFallback(ws: Workspace | null): string {
  const focusedId = getFocusedId();
  const pane = ws
    ? (focusedId ? ws.panes.get(focusedId) : undefined) ?? [...ws.panes.values()][0]
    : undefined;
  return pane?.cwd ?? pane?.initialCwd ?? pane?.spec.cwd ?? "";
}

function renderPairWorktreeOption(path: string, branch: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = path;
  option.textContent = `${branch} — ${path}`;
  option.title = path;
  return option;
}

/** 既存 worktree の一覧を読み、新規ペアの作業場所セレクトへ反映する。 */
async function loadPairWorktrees(): Promise<void> {
  const token = ++worktreeLoadToken;
  const ws = getActiveWs();
  const fallback = pairCwdFallback(ws);
  // 監視中の gitRoot はセッション切替直後だけ古いことがある。現在フォーカス中の
  // pane の cwd を優先すれば、別リポジトリ / 別 worktree を誤って一覧化しない。
  const root = fallback || getGitRoot() || "";
  newWorktreeSel.textContent = "";
  const manual = document.createElement("option");
  manual.value = "";
  manual.textContent = t("takeover.destination");
  newWorktreeSel.append(manual);
  newCwdInput.value = fallback;
  if (!root) return;

  try {
    const result = await invoke<WorktreeList>("git_worktree_list", { root });
    if (token !== worktreeLoadToken || overlay.hidden || !modeNewRadio.checked) return;
    for (const entry of result.entries) {
      // 欠損・bare・detached の行はブランチに紐づく作業場所として選べない。
      if (entry.missing || entry.bare || !entry.branch || !entry.path) continue;
      newWorktreeSel.append(renderPairWorktreeOption(entry.path, entry.branch));
    }
    const current = [...newWorktreeSel.options].find((option) => option.value === fallback);
    if (current) {
      newWorktreeSel.value = fallback;
    }
  } catch {
    // Worktree 情報が読めない場合も、Finder / 手入力の cwd では作成できる。
  }
}

async function choosePairCwd(): Promise<void> {
  newCwdBrowseBtn.disabled = true;
  try {
    const picked = await openFolderDialog({
      directory: true,
      multiple: false,
      title: t("takeover.destination"),
      defaultPath: newCwdInput.value.trim() || undefined,
    });
    if (typeof picked === "string" && picked) {
      newCwdInput.value = picked;
      newWorktreeSel.value = "";
    }
  } catch (e) {
    console.error("pair folder picker failed:", e);
  } finally {
    newCwdBrowseBtn.disabled = false;
    newCwdInput.focus();
  }
}

/** 改行を保った貼り付け。相手の TUI が bracketed paste を有効にしていれば
    マーカーで包み、改行が「途中で Enter」と解釈されないようにする
    （xterm の paste() と同じ変換。broadcast を経由させないため直接 write する）。
    判定は Rust が PTY 出力から追跡した pane.bracketedPaste（pty:mode）を正とする:
    非表示セッションのペインは xterm にバイトが届かず term.modes が古いままになる。
    submit 時の Enter は貼り付けの pty_write が完了してから ENTER_DELAY_MS 待って
    別送する（キュー投入時から数えると大きな diff の配送中に Enter が届き、
    TUI がペーストバースト内の改行として飲んでしまう）。送信後は pendingSubmits に
    記録し、次の静止で実働が確認できなければ notifyPairActivity が Enter を再送する */
function pasteToPane(st: PairState, pane: Pane, text: string, submit: boolean) {
  const normalized = text.replace(/\r?\n/g, "\r");
  const bracketed = pane.bracketedPaste ?? pane.term.modes.bracketedPasteMode;
  const data = bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
  if (!submit) {
    pane.write(data);
    return;
  }
  void pane
    .writeAndWait(data)
    .then(() => new Promise<void>((resolve) => window.setTimeout(resolve, ENTER_DELAY_MS)))
    .then(() => {
      if (!pane.alive) return;
      pane.write("\r");
      if (pairs.get(st.ws.id) === st && st.phase !== "done") {
        st.pendingSubmits.set(pane.id, { retries: SUBMIT_MAX_RETRIES });
        st.pendingTurn.add(pane.id); // このターンの完了シグナルを受け付ける
      }
    });
}

/** ペインの画面末尾のテキストを取る。TUI の描画をそのまま写すので枠線等の
    ノイズは残るが、受け手はエージェントなので実害は小さい */
function capturePaneTail(pane: Pane): string {
  try {
    const buf = pane.term.buffer.active;
    const rows: { text: string; wrapped: boolean }[] = [];
    for (let i = buf.length - 1; i >= 0 && rows.length < CAPTURE_MAX_LINES; i--) {
      const line = buf.getLine(i);
      if (!line) break;
      const text = line.translateToString(true).trimEnd();
      if (rows.length === 0 && !text) continue; // 末尾の空行は読み飛ばす
      rows.push({ text, wrapped: line.isWrapped });
    }
    rows.reverse();
    const lines: string[] = [];
    for (const row of rows) {
      // 折り返しで分かれた行は元の1行に繋ぎ直す
      if (row.wrapped && lines.length) lines[lines.length - 1] += row.text;
      else lines.push(row.text);
    }
    let joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (joined.length > CAPTURE_MAX_CHARS) joined = joined.slice(-CAPTURE_MAX_CHARS);
    return joined;
  } catch {
    return ""; // dispose 済み等。空のフィードバックとして送る
  }
}

/** ペインのシェル実 cwd（pty_cwd）を優先し、取れなければ OSC 7 / spec.cwd に
    フォールバックする（変更ストリップ・サイドバー git バッジと同じ解決順） */
async function resolvePaneCwd(pane: Pane): Promise<string | null> {
  if (pane.alive) {
    try {
      const live = await invoke<string | null>("pty_cwd", { id: pane.id });
      if (live) return live;
    } catch {
      /* フォールバックへ */
    }
  }
  return pane.cwd ?? pane.spec.cwd ?? null;
}

type GitSummary = { repo: boolean; fileCount: number };
type GitWorktreeDiff = { patch: string };

/** レビュー依頼の元になる材料。`diff` は実装役の cwd から確定させた unified diff
    （非リポジトリ・取得失敗など判定できないときは空文字＝「取れなかったが従来どおり
    レビューへは進める」）。`skip: true` は未コミットの変更が実際に無いと確認できた
    ケースで、この場合はレビューへ進めない */
type ReviewMaterial = { skip: true } | { skip: false; diff: string };

/** 実装役の cwd（pty_cwd）から git_summary で未コミットの変更（未追跡含む）の
    有無を確認し、あれば git_worktree_diff で unified diff を取得する。
    レビュー役自身のシェルの cwd には一切依存しない（別ディレクトリに cd して
    いても正しい対象を見せられる）。cwd が取れない・非リポジトリ・取得失敗など
    判定できない場合は skip:false・diff:"" で従来どおりレビューへ進める
    （誤ってレビューを止めないため） */
async function resolveReviewMaterial(st: PairState): Promise<ReviewMaterial> {
  // イベントから渡されたペインではなく、ペア状態に保存した実装役を使う。
  // これでレビュー役・別セッションの cwd がレビュー材料へ混ざらない。
  const pane = st.ws.panes.get(st.aId);
  if (!pane || pane.ws !== st.ws) return { skip: false, diff: "" };
  const cwd = await resolvePaneCwd(pane);
  if (!cwd) return { skip: false, diff: "" };
  const summary = await invoke<GitSummary>("git_summary", { cwd }).catch(() => null);
  if (!summary || !summary.repo) return { skip: false, diff: "" };
  if (summary.fileCount === 0) return { skip: true };
  const diffRes = await invoke<GitWorktreeDiff>("git_worktree_diff", { cwd }).catch(() => null);
  let diff = diffRes?.patch ?? "";
  if (diff.length > DIFF_MAX_CHARS) diff = diff.slice(0, DIFF_MAX_CHARS);
  return { skip: false, diff };
}

/** 受け渡しボタン（implTurn / attaching）の本体: 実装役の cwd から diff を
    確定させてレビュー依頼を送る。未コミットの変更が無いと確認できたとき
    （＝レビュー対象が無いのに受け渡してしまうケース）は送らず、ラウンドも
    消費しない。await 中に状態が変わっていたら何もしない
    （ペア停止・完了・一時停止・ペイン終了） */
async function sendReviewHandoff(st: PairState) {
  st.handoffBusy = true;
  updatePairStrip();
  try {
    const material = await resolveReviewMaterial(st);
    if (pairs.get(st.ws.id) !== st || st.phase === "done" || st.paused) return;
    const impl = st.ws.panes.get(st.aId);
    const review = st.ws.panes.get(st.bId);
    if (!impl?.alive || !review?.alive) {
      endPair(st, t("pair.statusExited"));
      return;
    }
    if (material.skip) {
      st.noteKey = "pair.noReviewChanges"; // レビュー対象なし。実装ターンのまま留まる
      return;
    }
    st.round += 1;
    st.phase = "reviewTurn";
    let prompt = t("pair.promptReview", { diff: material.diff });
    // あとづけの「レビューの観点」はユーザーの補足として末尾に添える
    if (st.reviewFocus) prompt += `\n\n${t("pair.promptUserNote", { note: st.reviewFocus })}`;
    pasteToPane(st, review, prompt, true);
  } finally {
    st.handoffBusy = false;
    updatePairStrip();
  }
}

/** クロスレビューの初回依頼（対象の指定があれば補足として添える） */
function crossSeedText(target: string): string {
  let text = t("pair.promptCrossSeed");
  if (target) text += `\n\n${t("pair.promptUserNote", { note: target })}`;
  return text;
}

/** 新規ペアセッションの自動採番名（保存されるデータなので翻訳しない） */
export function nextPairSessionName(): string {
  let max = 0;
  for (const ws of workspaces) {
    const m = /^Pair (\d+)$/.exec(ws.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Pair ${max + 1}`;
}

/** 静止確認タイマーと Enter 再送の記録をまとめて破棄する。
    終了・停止・一時停止・セッションクローズの回収から呼ぶ */
function clearPairTimers(st: PairState) {
  for (const timer of st.idleTimers.values()) window.clearTimeout(timer);
  st.idleTimers.clear();
  st.pendingSubmits.clear();
}

function endPair(st: PairState, message: string, finished = false) {
  clearPairTimers(st);
  releasePairSignals(st);
  st.pendingTurn.clear();
  st.phase = "done";
  st.finished = finished;
  st.endMessage = message;
  st.noteKey = undefined;
  updatePairStrip();
}

function stopPair(ws: Workspace) {
  const st = pairs.get(ws.id);
  if (!st) return;
  clearPairTimers(st);
  releasePairSignals(st);
  pairs.delete(ws.id);
  updatePairStrip();
}

/** Locked 遷移時（main.ts の onLicenseChange から）: 稼働中の全ペアを一時停止する。
    自動送信・確認待ちタイマーを止めるだけで、ペイン・プロセス・表示は殺さない
    （購入・キー登録後にストリップの再開ボタンから続きへ戻れる） */
export function stopPairAutoRelay() {
  for (const st of pairs.values()) {
    if (st.phase === "done" || st.paused) continue;
    st.paused = true;
    clearPairTimers(st);
  }
  updatePairStrip();
}

/** ブレスト完了後の「実装へ進む」。同じ2ペイン・同じ会話文脈のまま coop の
    分担フェーズへ入る（エージェントは議論を覚えているので続きとして計画が出る） */
function promotePair(st: PairState) {
  if (st.kind !== "brainstorm" || st.phase !== "done" || !st.finished) return;
  const a = st.ws.panes.get(st.aId);
  const b = st.ws.panes.get(st.bId);
  if (!a?.alive || !b?.alive) return;
  st.kind = "coop";
  st.building = true;
  st.maxSync = DEFAULT_SYNC_ROUNDS;
  st.syncCount = 0;
  st.finished = false;
  st.endMessage = undefined;
  st.phase = "plan";
  pasteToPane(st, a,t("pair.promptCoopPlan"), true);
  updatePairStrip();
}

/** bothWorking のバリア発火: 両ペインが静止した。cross は指摘の交換または統合へ、
    coop は進捗の同期または仕上げへ進む。キャプチャは貼り付け前にまとめて取る */
function fireBarrier(st: PairState) {
  const a = st.ws.panes.get(st.aId);
  const b = st.ws.panes.get(st.bId);
  if (!a?.alive || !b?.alive) {
    endPair(st, t("pair.statusExited"));
    return;
  }
  st.sideA.hadBusy = false;
  st.sideA.idleSeen = false;
  st.sideB.hadBusy = false;
  st.sideB.idleSeen = false;
  if (st.kind === "cross") {
    if (st.round >= st.maxRounds) {
      st.phase = "merge";
      pasteToPane(st, a,t("pair.promptCrossMerge", { review: capturePaneTail(b) }), true);
    } else {
      st.round += 1;
      const capA = capturePaneTail(a);
      const capB = capturePaneTail(b);
      pasteToPane(st, a,t("pair.promptCrossExchange", { review: capB }), true);
      pasteToPane(st, b,t("pair.promptCrossExchange", { review: capA }), true);
    }
  } else {
    // coop の同時実装
    if (st.syncCount >= st.maxSync) {
      st.phase = "wrapUp";
      pasteToPane(st, a,t("pair.promptCoopWrap"), true);
    } else {
      st.syncCount += 1;
      const capA = capturePaneTail(a);
      const capB = capturePaneTail(b);
      pasteToPane(st, a,t("pair.promptCoopSync", { progress: capB }), true);
      pasteToPane(st, b,t("pair.promptCoopSync", { progress: capA }), true);
    }
  }
  updatePairStrip();
}

/** app/activity.ts の pty:act リスナーから毎遷移で呼ばれる。
    busy / waiting は activity 側の解釈済みの値（waiting は engaged ゲート込み） */
export function notifyPairActivity(pane: Pane, busy: boolean, busyMs: number, waiting: boolean) {
  const st = pairs.get(pane.ws.id);
  if (!st || st.phase === "done") return;
  const isA = pane.id === st.aId;
  const isB = pane.id === st.bId;
  if (!isA && !isB) return;
  const side = isA ? st.sideA : st.sideB;
  if (busy) {
    // 出力が再開した = 直前の静止は思考待ちや無出力ツール実行の一時的な沈黙。
    // 確認待ちのハンドオフを取り消す
    const timer = st.idleTimers.get(pane.id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      st.idleTimers.delete(pane.id);
    }
    let changed = false;
    // バリア中: 作業が再開した側の「静止済み」を取り消す（古いキャプチャを送らない）。
    // シグナル管理ペインの idleSeen は完了フック由来の確定情報なので、
    // その後の TUI 再描画による busy では取り消さない
    if (st.phase === "bothWorking") {
      side.hadBusy = true;
      if (side.idleSeen && !paneSignalTokens.has(pane.id)) {
        side.idleSeen = false;
        changed = true;
      }
    }
    if (st.awaitingUser) {
      st.awaitingUser = false;
      changed = true;
    }
    if (changed) {
      updatePairStrip();
    }
    return;
  }
  if (st.paused) return;
  if (waiting) {
    // 承認ダイアログ等。自動では絶対に答えない。ユーザーが応答して
    // 次に静止したところからターンを再開する
    if (!st.awaitingUser) {
      st.awaitingUser = true;
      updatePairStrip();
    }
    return;
  }
  if (st.awaitingUser) {
    st.awaitingUser = false;
    updatePairStrip();
  }
  if (!pane.activityEngaged) return; // シェル初期化出力だけの静止では回さない
  // Enter ウォッチドッグ: submit 済みペインの静止が短い（貼り付けエコーの描画だけで
  // 実働が無い）= Enter が TUI に飲まれた。Enter だけを再送する。
  // waiting の静止は上で return 済みなので、承認ダイアログへ自動 Enter することはない
  const rec = st.pendingSubmits.get(pane.id);
  if (rec) {
    if (busyMs >= MIN_TURN_MS) {
      st.pendingSubmits.delete(pane.id); // 実働があった = プロンプトは取り込まれた
    } else if (rec.retries > 0) {
      rec.retries -= 1;
      pane.write("\r");
      return;
    } else {
      st.pendingSubmits.delete(pane.id); // 再送し尽くした。通常処理へ戻す
    }
  }
  // シグナル管理ペインの受け渡しは agent:turn（完了フック）だけで回す。
  // 静止検知の遷移を併走させると二重発火するのでここで打ち切る。
  // ただし起動待ち（starting / attaching / cross の開始指示前）はまだターンが
  // 無くフックも鳴らないので、従来どおり起動出力の静止で進める
  if (paneSignalTokens.has(pane.id)) {
    const booting =
      st.phase === "starting" ||
      st.phase === "attaching" ||
      (st.phase === "bothWorking" && !side.seeded);
    if (!booting) return;
  }
  // 静止をすぐには「ターン完了」にせず、HANDOFF_CONFIRM_MS 待って再確認する。
  // この間に出力が再開したら busy 分岐がタイマーを取り消す（バグ: 思考中の
  // 2秒の沈黙で中途半端な作業がレビューへ渡っていた）
  scheduleIdleConfirm(st, pane, busyMs);
}

/** ペイン別の静止確認タイマーを張り直す。発火時に状態が変わっていなければ
    handleConfirmedIdle でターンを進める */
function scheduleIdleConfirm(st: PairState, pane: Pane, busyMs: number) {
  const prev = st.idleTimers.get(pane.id);
  if (prev !== undefined) window.clearTimeout(prev);
  const phaseAt = st.phase;
  const timer = window.setTimeout(() => {
    st.idleTimers.delete(pane.id);
    if (pairs.get(st.ws.id) !== st || st.paused) return;
    if (st.phase !== phaseAt || !pane.alive || pane.busy || pane.waiting) return;
    handleConfirmedIdle(st, pane, busyMs);
  }, HANDOFF_CONFIRM_MS);
  st.idleTimers.set(pane.id, timer);
}

/** 静止が確認できたペインのターンを進める（旧 notifyPairActivity の idle 側の本体）。
    busyMs は静止直前の活動の長さ（確認待ちの時間は含まない） */
function handleConfirmedIdle(st: PairState, pane: Pane, busyMs: number) {
  const isA = pane.id === st.aId;
  const isB = pane.id === st.bId;
  const side = isA ? st.sideA : st.sideB;
  if (st.phase === "starting") {
    // replace / new: A の起動出力が静止したら初回プロンプトを送る
    if (!isA) return;
    const task = st.pendingTask;
    st.pendingTask = undefined;
    st.phase = st.afterStart;
    if (task) pasteToPane(st, pane,task, true);
    updatePairStrip();
    return;
  }
  if (st.phase === "attaching") {
    // あとづけ: レビュー役の起動出力が静止したら実装ターンへ。最初のレビュー依頼は
    // 自動では送らず、ユーザーが受け渡しボタン（レビューへ渡す）で行う
    if (!isB) return;
    const a = st.ws.panes.get(st.aId);
    if (!a || !a.alive) {
      endPair(st, t("pair.statusExited"));
      return;
    }
    st.phase = "implTurn";
    updatePairStrip();
    return;
  }
  if (st.phase === "bothWorking") {
    if (!side.seeded) {
      // cross の replace / new: 起動出力が静止した側からレビュー依頼を配る
      side.seeded = true;
      if (st.seedText) pasteToPane(st, pane,st.seedText, true);
      updatePairStrip();
      return;
    }
    if (busyMs < MIN_TURN_MS || !side.hadBusy) return;
    side.idleSeen = true;
    const other = isA ? st.sideB : st.sideA;
    // 自動バリアは cross（レビューの突き合わせ）だけ。coop の同時実装は
    // 「実装完了」を静止から判定できないので、同期はユーザーのボタン操作で行う
    if (st.kind === "cross" && other.seeded && other.idleSeen) fireBarrier(st);
    else updatePairStrip(); // 「相方待ち」等の表示
    return;
  }
  if (busyMs < MIN_TURN_MS) return;
  // implTurn（実装役の作業中）は自動では何もしない: レビューへの受け渡しも
  // ラウンド上限での完了も、実装の区切りの判定が要るのでボタンから行う
  if (st.phase === "reviewTurn" && isB) {
    const impl = st.ws.panes.get(st.aId);
    if (!impl || !impl.alive) {
      endPair(st, t("pair.statusExited"));
      return;
    }
    const feedback = capturePaneTail(pane);
    st.phase = "implTurn";
    pasteToPane(st, impl,t("pair.promptRevise", { review: feedback }), true);
    updatePairStrip();
    return;
  }
  if (st.phase === "aTurn" && isA) {
    if (st.round >= st.maxRounds) {
      // 議論はここまで。brainstorm はまとめへ、coop は分担へ
      if (st.kind === "coop") {
        st.building = true;
        st.phase = "plan";
        pasteToPane(st, pane,t("pair.promptCoopPlan"), true);
      } else {
        st.phase = "summary";
        pasteToPane(st, pane,t("pair.promptBrainSummary"), true);
      }
      updatePairStrip();
      return;
    }
    const b = st.ws.panes.get(st.bId);
    if (!b || !b.alive) {
      endPair(st, t("pair.statusExited"));
      return;
    }
    st.round += 1;
    st.phase = "bTurn";
    const ideas = capturePaneTail(pane);
    // 批判役スタイルは B へ送るプロンプトだけを差し替える（A への返しは常に発展型）
    const key: MsgKey =
      st.kind === "brainstorm" && st.style === "critic"
        ? "pair.promptBrainCritic"
        : "pair.promptBrainRespond";
    pasteToPane(st, b,t(key, { ideas }), true);
    updatePairStrip();
    return;
  }
  if (st.phase === "bTurn" && isB) {
    const a = st.ws.panes.get(st.aId);
    if (!a || !a.alive) {
      endPair(st, t("pair.statusExited"));
      return;
    }
    st.phase = "aTurn";
    pasteToPane(st, a,t("pair.promptBrainRespond", { ideas: capturePaneTail(pane) }), true);
    updatePairStrip();
    return;
  }
  if (st.phase === "plan" && isA) {
    const b = st.ws.panes.get(st.bId);
    if (!b || !b.alive) {
      endPair(st, t("pair.statusExited"));
      return;
    }
    // 分担表は A の画面から写して B に渡す。以降は両方同時に実装（バリア同期）
    const plan = capturePaneTail(pane);
    st.phase = "bothWorking";
    st.sideA = { seeded: true, hadBusy: false, idleSeen: false };
    st.sideB = { seeded: true, hadBusy: false, idleSeen: false };
    pasteToPane(st, pane,t("pair.promptCoopStartA"), true);
    pasteToPane(st, b,t("pair.promptCoopStartB", { plan }), true);
    updatePairStrip();
    return;
  }
  // 完了の自動判定は返答型の summary / merge だけ。wrapUp は A が実装作業を
  // している（静止から完了を判定できない）ので、完了はボタンから行う
  if ((st.phase === "summary" || st.phase === "merge") && isA) {
    endPair(st, t(st.phase === "summary" ? "pair.doneBrainstorm" : "pair.doneCross"), true);
  }
}

/** app/activity.ts の agent:turn リスナーから。エージェント CLI の完了フック
    （claude Stop / codex agent-turn-complete）が鳴らした「ターン完了」の確定通知。
    出力の静止と違って誤発火しないので、確認デバウンスなしで即受け渡す */
export function notifyPairSignal(token: string) {
  const target = signalTokens.get(token);
  if (!target) return; // 終了済みペアの迷子シグナル等
  const st = pairs.get(target.wsId);
  if (!st || st.phase === "done" || st.paused) return;
  const paneId = target.paneId;
  if (paneId !== st.aId && paneId !== st.bId) return;
  const pane = st.ws.panes.get(paneId);
  if (!pane?.alive || pane.waiting) return; // 承認待ち中は何もしない（安全側）
  // ペア自身が送ったプロンプトのターンだけ消費する（ユーザーが手で打った
  // 割り込みターンの完了フックで誤受け渡ししない）
  if (!st.pendingTurn.has(paneId)) return;
  st.pendingTurn.delete(paneId);
  advanceOnTurnComplete(st, paneId);
}

/** シグナルで確定したターン完了の遷移。フェーズの担当ペインからの通知だけを進め、
    実処理は手動ボタンと同じ performHandoff（バリアは相方の完了も確認）に委ねる */
function advanceOnTurnComplete(st: PairState, paneId: string) {
  const isA = paneId === st.aId;
  if (st.phase === "bothWorking") {
    const side = isA ? st.sideA : st.sideB;
    if (!side.seeded) return;
    side.idleSeen = true;
    const other = isA ? st.sideB : st.sideA;
    // coop の同期は「実装完了」を要するので、相方の完了もシグナルで確認できる
    // ときだけ自動発火する（cross のレビューは返答型なので静止検知の相方でも可）。
    // 混在で自動発火しない組は従来どおり手動ボタンで同期する
    const otherArmed = paneSignalTokens.has(isA ? st.bId : st.aId);
    if (other.seeded && other.idleSeen && (st.kind === "cross" || otherArmed)) fireBarrier(st);
    else updatePairStrip(); // 相方待ち表示
    return;
  }
  const aTurnPhase =
    st.phase === "implTurn" ||
    st.phase === "aTurn" ||
    st.phase === "plan" ||
    st.phase === "merge" ||
    st.phase === "summary" ||
    st.phase === "wrapUp";
  const bTurnPhase = st.phase === "reviewTurn" || st.phase === "bTurn";
  // starting / attaching は起動待ちでターンが無い（pendingTurn ゲートでも弾かれる）
  if ((aTurnPhase && !isA) || (bTurnPhase && isA) || (!aTurnPhase && !bTurnPhase)) return;
  performHandoff(st);
}

/** いまのフェーズの担当ペインが完了フックで自動受け渡しされる状態か（状態文の付記用） */
function autoArmedForPhase(st: PairState): boolean {
  const aArmed = paneSignalTokens.has(st.aId);
  const bArmed = paneSignalTokens.has(st.bId);
  switch (st.phase) {
    case "implTurn":
    case "aTurn":
    case "plan":
    case "merge":
    case "summary":
    case "wrapUp":
      return aArmed;
    case "reviewTurn":
    case "bTurn":
      return bArmed;
    case "bothWorking":
      return st.kind === "cross" ? aArmed || bArmed : aArmed && bArmed;
    default:
      return false;
  }
}

/** 常設の受け渡しボタンのフェーズ別ラベル（MsgKey）。null はボタンを出さない */
function handoffLabel(st: PairState): MsgKey | null {
  switch (st.phase) {
    case "starting":
      return "pair.sendStart";
    case "attaching":
      return "pair.sendReview";
    case "implTurn":
      return st.round >= st.maxRounds ? "pair.finish" : "pair.sendReview";
    case "reviewTurn":
      return "pair.sendFeedback";
    case "aTurn":
      if (st.round >= st.maxRounds) return st.kind === "coop" ? "pair.sendPlan" : "pair.sendSummary";
      return "pair.sendIdeas";
    case "bTurn":
      return "pair.sendIdeas";
    case "plan":
      return "pair.sendBuildStart";
    case "bothWorking":
      if (!st.sideA.seeded || !st.sideB.seeded) return "pair.sendStart";
      if (st.kind === "cross") return st.round >= st.maxRounds ? "pair.sendMerge" : "pair.sendExchange";
      return st.syncCount >= st.maxSync ? "pair.sendWrapUp" : "pair.sendSync";
    default:
      return null;
  }
}

/** 常設の受け渡しボタンの本体: 押した時点のキャプチャ / diff で、そのフェーズの
    自動遷移と同じ受け渡しを即実行する。自動検知（静止確認）が外れたときの保険で
    あり、implTurn・coop の同期・wrapUp のように自動遷移を持たないフェーズでは
    これが唯一の受け渡し経路。手動遷移後に残った静止確認タイマーは
    scheduleIdleConfirm の phaseAt ガードが無効化するので二重送信にはならない */
function performHandoff(st: PairState) {
  if (st.paused || st.handoffBusy || st.phase === "done") return;
  st.noteKey = undefined;
  const a = st.ws.panes.get(st.aId);
  const b = st.ws.panes.get(st.bId);
  if (!a?.alive || !b?.alive) {
    endPair(st, t("pair.statusExited"));
    return;
  }
  switch (st.phase) {
    case "starting": {
      const task = st.pendingTask;
      st.pendingTask = undefined;
      st.phase = st.afterStart;
      if (task) pasteToPane(st, a, task, true);
      break;
    }
    case "attaching":
    case "implTurn": {
      if (st.phase === "implTurn" && st.round >= st.maxRounds) {
        endPair(st, t("pair.statusDone"), true);
        return;
      }
      void sendReviewHandoff(st); // 表示更新は diff 取得の完了側で行う
      return;
    }
    case "reviewTurn": {
      st.phase = "implTurn";
      pasteToPane(st, a, t("pair.promptRevise", { review: capturePaneTail(b) }), true);
      break;
    }
    case "aTurn": {
      if (st.round >= st.maxRounds) {
        if (st.kind === "coop") {
          st.building = true;
          st.phase = "plan";
          pasteToPane(st, a, t("pair.promptCoopPlan"), true);
        } else {
          st.phase = "summary";
          pasteToPane(st, a, t("pair.promptBrainSummary"), true);
        }
        break;
      }
      st.round += 1;
      st.phase = "bTurn";
      const ideas = capturePaneTail(a);
      const key: MsgKey =
        st.kind === "brainstorm" && st.style === "critic"
          ? "pair.promptBrainCritic"
          : "pair.promptBrainRespond";
      pasteToPane(st, b, t(key, { ideas }), true);
      break;
    }
    case "bTurn": {
      st.phase = "aTurn";
      pasteToPane(st, a, t("pair.promptBrainRespond", { ideas: capturePaneTail(b) }), true);
      break;
    }
    case "plan": {
      const plan = capturePaneTail(a);
      st.phase = "bothWorking";
      st.sideA = { seeded: true, hadBusy: false, idleSeen: false };
      st.sideB = { seeded: true, hadBusy: false, idleSeen: false };
      pasteToPane(st, a, t("pair.promptCoopStartA"), true);
      pasteToPane(st, b, t("pair.promptCoopStartB", { plan }), true);
      break;
    }
    case "bothWorking": {
      if (!st.sideA.seeded || !st.sideB.seeded) {
        // cross の replace / new でまだ開始指示が配りきれていない側へ配る
        if (st.seedText) {
          if (!st.sideA.seeded) pasteToPane(st, a, st.seedText, true);
          if (!st.sideB.seeded) pasteToPane(st, b, st.seedText, true);
        }
        st.sideA.seeded = true;
        st.sideB.seeded = true;
        break;
      }
      fireBarrier(st); // fireBarrier が表示更新まで行う
      return;
    }
    case "merge":
      endPair(st, t("pair.doneCross"), true);
      return;
    case "summary":
      endPair(st, t("pair.doneBrainstorm"), true);
      return;
    case "wrapUp":
      endPair(st, t("pair.doneCoop"), true);
      return;
  }
  updatePairStrip();
}

/** pty:exit（プロセス終了）。ペアの片方が死んだらペアを終了状態にする */
export function notifyPairExit(pane: Pane) {
  const st = pairs.get(pane.ws.id);
  if (!st || st.phase === "done") return;
  if (pane.id !== st.aId && pane.id !== st.bId) return;
  endPair(st, t("pair.statusExited"));
}

function phaseStatusText(st: PairState): string {
  if (st.phase === "starting") return t("pair.statusStarting");
  if (st.phase === "attaching") return t("pair.statusAttach");
  if (st.phase === "bothWorking") {
    if (st.sideA.idleSeen !== st.sideB.idleSeen) return t("pair.statusHalfDone");
    return t(st.kind === "cross" ? "pair.statusBothReview" : "pair.statusBothImpl");
  }
  if (st.phase === "aTurn") return t("pair.statusIdeaA");
  if (st.phase === "bTurn") return t("pair.statusIdeaB");
  if (st.phase === "plan") return t("pair.statusPlan");
  if (st.phase === "merge") return t("pair.statusMerge");
  if (st.phase === "summary") return t("pair.statusSummary");
  if (st.phase === "wrapUp") return t("pair.statusWrapUp");
  if (st.phase === "reviewTurn") return t("pair.statusReview");
  return t("pair.statusImpl");
}

function statusText(st: PairState): string {
  if (st.phase === "done") return st.endMessage ?? t("pair.statusDone");
  if (st.paused) return t("pair.statusPaused");
  if (st.awaitingUser) return t("pair.statusWaitApproval");
  if (st.noteKey) return t(st.noteKey);
  const base = phaseStatusText(st);
  // 完了フックが効いているターンには「自動で受け渡す」旨を付記する
  return autoArmedForPhase(st) ? base + t("pair.autoArmed") : base;
}

/** モード別のチップ表記（A / B の役割名 + アイコン）。coop は分担以降 🔧 に変わる */
function chipLabels(st: PairState): [string, string] {
  if (st.kind === "implement") return [`🔧 ${t("pair.impl")}`, `🔍 ${t("pair.review")}`];
  if (st.kind === "cross") return [`🔍 ${t("pair.chipReviewA")}`, `🔍 ${t("pair.chipReviewB")}`];
  if (st.kind === "coop" && st.building)
    return [`🔧 ${t("pair.chipImplA")}`, `🔧 ${t("pair.chipImplB")}`];
  return [`💡 ${t("pair.chipIdeaA")}`, `💡 ${t("pair.chipIdeaB")}`];
}

/** ペアストリップとツールバーボタンを表示中セッションの状態に合わせる。
    開始・停止・フェーズ遷移・セッション切替（main.ts の onActiveWorkspaceChange）から呼ぶ */
export function updatePairStrip() {
  // 閉じたセッションのペア状態を回収する（PTY には触らない）
  for (const [id, st] of pairs) {
    if (!workspaces.includes(st.ws)) {
      clearPairTimers(st);
      releasePairSignals(st);
      pairs.delete(id);
    }
  }
  const ws = getActiveWs();
  const st = ws ? pairs.get(ws.id) : undefined;
  const wasHidden = stripEl.hidden;
  stripEl.hidden = !st;

  const running = st && st.phase !== "done";
  openBtn.classList.toggle("is-on", Boolean(running));
  // coop の実装フェーズは同期回数、それ以外は受け渡し回数をカウンタに出す
  const showSync = st && st.kind === "coop" && st.building;
  const counterN = st ? (showSync ? st.syncCount : st.round) : 0;
  const counterMax = st ? (showSync ? st.maxSync : st.maxRounds) : 0;
  // SVG アイコンを保つため、ボタン全体ではなくラベル span だけ書き換える
  openLabelEl.textContent = running
    ? t("pair.buttonRunning", { n: String(counterN), max: String(counterMax) })
    : t("pair.toolbar");
  openBtn.title = t("pair.toolbarTitle");

  if (st) {
    stripNameEl.textContent = t("pair.title");
    const [aLabel, bLabel] = chipLabels(st);
    aChipEl.textContent = aLabel;
    bChipEl.textContent = bLabel;
    const active = !st.paused && !st.awaitingUser && st.phase !== "done";
    aChipEl.classList.toggle(
      "is-turn",
      active &&
        (st.phase === "starting" ||
          st.phase === "implTurn" ||
          st.phase === "aTurn" ||
          st.phase === "plan" ||
          st.phase === "merge" ||
          st.phase === "summary" ||
          st.phase === "wrapUp" ||
          (st.phase === "bothWorking" && !st.sideA.idleSeen)),
    );
    bChipEl.classList.toggle(
      "is-turn",
      active &&
        (st.phase === "reviewTurn" ||
          st.phase === "bTurn" ||
          st.phase === "attaching" ||
          (st.phase === "bothWorking" && !st.sideB.idleSeen)),
    );
    arrowEl.textContent =
      st.phase === "done"
        ? "✓"
        : st.phase === "starting" || st.phase === "attaching"
          ? "…"
          : st.phase === "bothWorking"
            ? "⇄"
            : st.phase === "reviewTurn" || st.phase === "bTurn"
              ? "→"
              : "←";
    roundEl.textContent = showSync
      ? t("pair.syncRound", { n: String(st.syncCount), max: String(st.maxSync) })
      : t("pair.round", { n: String(st.round), max: String(st.maxRounds) });
    // 稼働中はラウンド上限を後から増減できる（完了後は表示しない）。
    // coop の実装フェーズでは同期回数の上限が対象になる
    roundDecBtn.hidden = st.phase === "done";
    roundIncBtn.hidden = st.phase === "done";
    roundDecBtn.disabled = counterMax <= 1;
    roundIncBtn.disabled = counterMax >= PAIR_MAX_ROUNDS;
    roundDecBtn.title = t("pair.roundsDec");
    roundIncBtn.title = t("pair.roundsInc");
    statusEl.textContent = statusText(st);
    statusEl.classList.toggle("is-alarm", st.awaitingUser && st.phase !== "done");
    // レビュー役のターン中だけ、手動で実装役へ引き戻すボタンを出す（implement のみ）
    turnBackBtn.hidden = !(st.kind === "implement" && st.phase === "reviewTurn");
    turnBackBtn.textContent = t("pair.turnBack");
    turnBackBtn.title = t("pair.turnBackTitle");
    // ブレストが自然完了したときだけ「実装へ進む」（同じ2ペインで coop へ昇格）
    promoteBtn.hidden = !(
      st.kind === "brainstorm" &&
      st.phase === "done" &&
      st.finished &&
      st.ws.panes.get(st.aId)?.alive &&
      st.ws.panes.get(st.bId)?.alive
    );
    promoteBtn.textContent = t("pair.promote");
    promoteBtn.title = t("pair.promoteTitle");
    // 常設の受け渡しボタン（一時停止中と完了後は隠す）。ラベルはフェーズで変わる
    const labelKey = st.paused ? null : handoffLabel(st);
    handoffBtn.hidden = !labelKey;
    if (labelKey) {
      handoffBtn.textContent = t(labelKey);
      handoffBtn.disabled = st.handoffBusy;
      handoffBtn.title = t("pair.handoffTitle");
    }
    pauseBtn.hidden = st.phase === "done";
    pauseBtn.textContent = st.paused ? t("pair.resume") : t("pair.pause");
    stopBtn.textContent = t("pair.stop");
    stopBtn.title = t("pair.stopTitle");
  } else {
    handoffBtn.hidden = true;
    promoteBtn.hidden = true;
  }
  if (wasHidden !== stripEl.hidden) deps?.layout(); // 帯の高さが変わる = refit 必須
}

/** 言語切替時の貼り直し（動的テキストのみ。静的ラベルは applyStaticTexts が刻印） */
export function renderPairTexts() {
  updatePairStrip();
  if (!overlay.hidden) applyFormFields();
}

// ============================================================
// セットアップモーダル
// ============================================================

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function paneLabel(p: Pane): string {
  const cwd = p.cwd ?? p.spec.cwd ?? "";
  const tail = cwd ? cwd.replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/") : "";
  const title = p.spec.title ?? "shell";
  return tail ? `${title} — ${tail}` : title;
}

function currentKind(): PairKind {
  if (kindCrossRadio.checked) return "cross";
  if (kindBrainstormRadio.checked) return "brainstorm";
  if (kindCoopRadio.checked) return "coop";
  return "implement";
}

type Placement = "replace" | "current" | "new" | "attach";

function currentPlacement(): Placement {
  if (modeCurrentRadio.checked) return "current";
  if (modeNewRadio.checked) return "new";
  if (modeAttachRadio.checked) return "attach";
  return "replace";
}

/** あとづけレビューのコマンド既定値 = 実装役（フォーカス中ペイン）と逆のエージェント。
    claude が動いていれば codex、それ以外（codex・未検知）は claude */
function attachDefaultReviewCmd(): string {
  const impl = deps?.getFocusedPane();
  return impl?.spec.agent?.kind === "claude" ? "codex" : "claude";
}

/** モード（何をさせるか）と組み方（どう組むか）に応じてフィールドの表示と
    ラベルを揃える。共用フィールドはモードごとに意味が変わるのでここで刻印する */
function applyFormFields() {
  const kind = currentKind();
  // あとづけは実装×レビュー専用（入口×モードの組み合わせを増やさない）
  modeAttachWrap.hidden = kind !== "implement";
  if (kind !== "implement" && modeAttachRadio.checked) modeReplaceRadio.checked = true;
  styleField.hidden = kind !== "brainstorm";
  syncField.hidden = kind !== "coop";
  const placement = currentPlacement();
  const needsCommands = placement !== "current";
  currentFieldsEl.hidden = needsCommands;
  newFieldsEl.hidden = !needsCommands;
  newCwdFieldEl.hidden = placement !== "new";
  // あとづけの実装役は既存ペインなのでコマンド入力を出さない
  implCmdField.hidden = placement === "attach";
  const isImpl = kind === "implement";
  implPaneLabel.textContent = t(isImpl ? "pair.implPane" : "pair.paneA");
  reviewPaneLabel.textContent = t(isImpl ? "pair.reviewPane" : "pair.paneB");
  implCmdLabel.textContent = t(isImpl ? "pair.implCmd" : "pair.cmdA");
  reviewCmdLabel.textContent = t(isImpl ? "pair.reviewCmd" : "pair.cmdB");
  roundsLabel.textContent = t(
    isImpl ? "pair.rounds" : kind === "cross" ? "pair.roundsCross" : "pair.roundsBrainstorm",
  );
  // タスク欄の意味: implement=最初のタスク（あとづけ=レビューの観点）/
  // cross=レビュー対象の指定 / brainstorm・coop=お題（必須）
  const taskKey =
    kind === "brainstorm" || kind === "coop"
      ? "pair.topic"
      : kind === "cross"
        ? "pair.reviewTarget"
        : placement === "attach"
          ? "pair.reviewFocus"
          : "pair.task";
  taskLabel.textContent = t(taskKey as MsgKey);
  taskInput.placeholder = t(`${taskKey}Placeholder` as MsgKey);
}

/** モード・組み方・スタイル・ラウンド数・お題をフォームの初期値へ戻す。
    新規に開くたびの完全リセット用（前回入力の使い回しを防ぐ）。
    起動失敗直後の再オープン（同じ試行のやり直し）では呼ばない */
function resetFormDefaults() {
  kindImplementRadio.checked = true;
  modeReplaceRadio.checked = true;
  styleYesAndRadio.checked = true;
  roundsInput.value = String(KIND_DEFAULT_ROUNDS.implement);
  syncInput.value = String(DEFAULT_SYNC_ROUNDS);
  taskInput.value = "";
}

/** 開くたびに表示中セッションの状態へ同期する（稼働中なら停止だけを出す） */
function syncModal() {
  errorEl.hidden = true;
  const ws = getActiveWs();
  const st = ws ? pairs.get(ws.id) : undefined;
  runningEl.hidden = !st;
  form.hidden = Boolean(st);
  if (st) {
    runningTextEl.textContent = `${t("pair.running")} ${t("pair.round", {
      n: String(st.round),
      max: String(st.maxRounds),
    })}`;
    modalStopBtn.textContent = t("pair.stop");
    return;
  }
  // 起動コマンド欄は開くたびに現在の既定値へ同期する（worktree の prefs と同じ流儀）
  implCmdInput.value = pairDefaultCmds.implCmd;
  reviewCmdInput.value = pairDefaultCmds.reviewCmd;
  newCwdInput.value = "";
  const panes = ws ? [...ws.panes.values()] : [];
  const canPairCurrent = panes.length >= 2;
  modeCurrentRadio.disabled = !canPairCurrent;
  if (!canPairCurrent && modeCurrentRadio.checked) modeReplaceRadio.checked = true;
  implPaneSel.textContent = "";
  reviewPaneSel.textContent = "";
  for (const pane of panes) {
    for (const sel of [implPaneSel, reviewPaneSel]) {
      const opt = document.createElement("option");
      opt.value = pane.id;
      opt.textContent = paneLabel(pane);
      sel.append(opt);
    }
  }
  if (panes.length >= 2) {
    implPaneSel.value = panes[0].id;
    reviewPaneSel.value = panes[1].id;
  }
  newCwdInput.value = pairCwdFallback(ws);
  applyFormFields();
  if (currentPlacement() === "new") void loadPairWorktrees();
}

function setOpen(open: boolean, opts: { fresh?: boolean } = {}) {
  overlay.hidden = !open;
  openBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    // fresh=false は起動失敗直後の再オープン（同じ試行のやり直し）。
    // それ以外は毎回フォームを初期値へ戻してから同期する
    if (opts.fresh !== false) resetFormDefaults();
    syncModal();
  } else if (overlay.contains(document.activeElement)) {
    // 非表示の入力欄にフォーカスが残るとショートカットを飲む（定型文モーダルと同じ）
    deps?.focusTerminal();
  }
}

/** 起動コマンド・タスクの制御文字を安全側へ畳む（タスクは改行だけ残す） */
function normalizeCmd(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
}

function normalizeTask(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, 4000);
}

function clampRounds(value: string, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(PAIR_MAX_ROUNDS, n));
}

function setPairFormBusy(busy: boolean) {
  for (const control of form.querySelectorAll<HTMLElement>("input, textarea, select, button")) {
    if ("disabled" in control) (control as HTMLInputElement).disabled = busy;
  }
  if (!busy) {
    const ws = getActiveWs();
    modeCurrentRadio.disabled = !ws || ws.panes.size < 2;
  }
}

async function startFromForm() {
  if (startingPair) return;
  const ws = getActiveWs();
  if (!ws || !deps) return;
  if (pairs.has(ws.id)) {
    showError(t("pair.running"));
    return;
  }

  const kind = currentKind();
  const placement = currentPlacement();
  const maxRounds = clampRounds(roundsInput.value, KIND_DEFAULT_ROUNDS[kind]);
  const maxSync = clampRounds(syncInput.value, DEFAULT_SYNC_ROUNDS);
  const style: BrainStyle = styleCriticRadio.checked ? "critic" : "yesAnd";
  const task = normalizeTask(taskInput.value);
  const selectedCwd = placement === "new" ? newCwdInput.value.trim() || undefined : undefined;
  if ((kind === "brainstorm" || kind === "coop") && !task) {
    showError(t("pair.topicRequired"));
    return;
  }

  startingPair = true;
  setPairFormBusy(true);
  try {
    if (selectedCwd) {
      try {
        await invoke("fs_is_dir", { path: selectedCwd });
      } catch (e) {
        showError(t("pair.cwdError", { error: String(e) }));
        return;
      }
    }

    const baseState = (targetWs: Workspace, aId: string, bId: string): PairState => ({
      ws: targetWs,
      aId,
      bId,
      kind,
      style,
      maxRounds,
      round: 0,
      maxSync,
      syncCount: 0,
      building: false,
      phase: "starting",
      afterStart: kind === "implement" ? "implTurn" : "aTurn",
      paused: false,
      awaitingUser: false,
      handoffBusy: false,
      sideA: { seeded: false, hadBusy: false, idleSeen: false },
      sideB: { seeded: false, hadBusy: false, idleSeen: false },
      finished: false,
      pendingSubmits: new Map(),
      pendingTurn: new Set(),
      idleTimers: new Map(),
    });

    // 開始時に A へ送る初回プロンプト（implement は任意タスク、他モードは必須の定型）
    const seedForA =
      kind === "implement"
        ? task || undefined
        : kind === "cross"
          ? crossSeedText(task)
          : t("pair.promptBrainSeed", { topic: task });

    if (placement === "attach") {
      // あとづけレビュー: フォーカス中ペイン = 実装役、その隣にレビュー役を作る
      const impl = deps.getFocusedPane();
      if (!impl) {
        showError(t("pair.needTwoPanes"));
        return;
      }
      const reviewCmd = normalizeCmd(reviewCmdInput.value) || attachDefaultReviewCmd();
      setOpen(false);
      // レビュー役は自分で起動するので完了フックを注入できる（実装役は既存プロセス
      // のため注入不可 = implTurn は手動ボタンのまま）
      const sigDir = await ensureSignalDir();
      const bToken = crypto.randomUUID();
      const reviewRun = sigDir ? withCompletionSignal(reviewCmd, bToken, sigDir) : null;
      const review = await deps.addReviewerPane({ impl, cmd: reviewRun ?? reviewCmd });
      if (!review) return; // await 中にペイン / セッションが消えた
      if (pairs.has(impl.ws.id)) return; // await 中に別のペアが組まれた
      if (reviewRun) registerPairSignal(bToken, review);
      const st = baseState(impl.ws, impl.id, review.id);
      st.phase = "attaching";
      st.reviewFocus = task || undefined;
      pairs.set(impl.ws.id, st);
      updatePairStrip();
      return;
    }

    const implCmd = normalizeCmd(implCmdInput.value) || pairDefaultCmds.implCmd;
    const reviewCmd = normalizeCmd(reviewCmdInput.value) || pairDefaultCmds.reviewCmd;

    if (placement === "replace" || placement === "new") {
      setOpen(false);
      // 両ペインとも自分で起動するので、claude / codex には完了フックを注入する
      // （注入できないコマンドは素のまま起動し、シグナル管理にもしない）
      const sigDir = await ensureSignalDir();
      const aToken = crypto.randomUUID();
      const bToken = crypto.randomUUID();
      const implRun = sigDir ? withCompletionSignal(implCmd, aToken, sigDir) : null;
      const reviewRun = sigDir ? withCompletionSignal(reviewCmd, bToken, sigDir) : null;
      const spawnCmds = { implCmd: implRun ?? implCmd, reviewCmd: reviewRun ?? reviewCmd };
      // replace: 今のセッションの中にペアの2ペインを作り、元のペインを閉じる
      const created =
        placement === "replace"
          ? await deps.replacePanesWithPair(spawnCmds)
          : await deps.createPairSession({ ...spawnCmds, cwd: selectedCwd });
      if (!created) return; // await 中にセッションが閉じられた等
      const [a, b] = created;
      if (implRun) registerPairSignal(aToken, a);
      if (reviewRun) registerPairSignal(bToken, b);
      const st = baseState(a.ws, a.id, b.id);
      if (kind === "cross") {
        // 両ペインとも「起動出力が静止した側から」レビュー依頼を配る（seeded 管理）
        st.phase = "bothWorking";
        st.seedText = seedForA;
      } else {
        st.pendingTask = seedForA;
      }
      pairs.set(a.ws.id, st);
      updatePairStrip();
      return;
    }

    // 既存2ペインで組む（エージェントは起動済みの前提なので初回プロンプトは即送る）
    const aId = implPaneSel.value;
    const bId = reviewPaneSel.value;
    if (!aId || !bId || !ws.panes.has(aId) || !ws.panes.has(bId)) {
      showError(t("pair.needTwoPanes"));
      return;
    }
    if (aId === bId) {
      showError(t("pair.samePane"));
      return;
    }
    const a = ws.panes.get(aId)!;
    const b = ws.panes.get(bId)!;
    const st = baseState(ws, aId, bId);
    setOpen(false);
    if (kind === "cross") {
      st.phase = "bothWorking";
      st.sideA.seeded = true;
      st.sideB.seeded = true;
      pairs.set(ws.id, st);
      pasteToPane(st, a,seedForA!, true);
      pasteToPane(st, b,seedForA!, true);
    } else if (kind === "implement") {
      st.phase = "implTurn";
      pairs.set(ws.id, st);
      if (task) pasteToPane(st, a,task, true);
    } else {
      st.phase = "aTurn";
      pairs.set(ws.id, st);
      pasteToPane(st, a,seedForA!, true);
    }
    updatePairStrip();
  } catch (e) {
    setOpen(true, { fresh: false });
    if (placement === "new") {
      modeNewRadio.checked = true;
      applyFormFields();
      newCwdInput.value = selectedCwd ?? "";
    }
    showError(t("pair.createError", { error: String(e) }));
  } finally {
    startingPair = false;
    setPairFormBusy(false);
  }
}

export function initPairMode(nextDeps: PairDeps) {
  deps = nextDeps;
  openBtn.onclick = () => {
    if (requireFeature()) setOpen(true); // ペアモードはソフトロック対象
  };
  closeBtn.onclick = () => setOpen(false);
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) setOpen(false);
  });
  // 入力中のキーをアプリショートカットやターミナルへ流さない（開いている間だけ）
  panel.addEventListener("keydown", (e) => {
    if (!overlay.hidden) e.stopPropagation();
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      if (!overlay.hidden) {
        e.stopPropagation();
        setOpen(false);
      }
    },
    true,
  );
  // モード切替はラウンドの既定値もモードに合わせて入れ直す
  for (const radio of [kindImplementRadio, kindCrossRadio, kindBrainstormRadio, kindCoopRadio]) {
    radio.onchange = () => {
      roundsInput.value = String(KIND_DEFAULT_ROUNDS[currentKind()]);
      syncInput.value = String(DEFAULT_SYNC_ROUNDS);
      applyFormFields();
    };
  }
  modeReplaceRadio.onchange = applyFormFields;
  modeCurrentRadio.onchange = applyFormFields;
  modeNewRadio.onchange = () => {
    applyFormFields();
    void loadPairWorktrees();
  };
  modeAttachRadio.onchange = () => {
    // 実装役（フォーカス中ペイン）と逆のエージェントをレビュー役の既定にする
    reviewCmdInput.value = attachDefaultReviewCmd();
    applyFormFields();
  };
  styleYesAndRadio.onchange = applyFormFields;
  styleCriticRadio.onchange = applyFormFields;
  newWorktreeSel.addEventListener("change", () => {
    if (newWorktreeSel.value) newCwdInput.value = newWorktreeSel.value;
  });
  newCwdInput.addEventListener("input", () => {
    // 手入力へ切り替えたら、選択中の worktree 表示を外して曖昧さを残さない。
    if (newWorktreeSel.value !== newCwdInput.value) newWorktreeSel.value = "";
  });
  newCwdBrowseBtn.onclick = () => void choosePairCwd();
  taskQuickBtn.onclick = () => openQuickPhrasesFor(taskInput);
  form.onsubmit = (e) => {
    e.preventDefault();
    void startFromForm();
  };
  modalStopBtn.onclick = () => {
    const ws = getActiveWs();
    if (ws) stopPair(ws);
    syncModal();
  };
  // 帯のボタン操作をターミナル・グローバルショートカットへ流さない（他の帯と同じ流儀）
  stripEl.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLButtonElement) e.stopPropagation();
  });
  const adjustRounds = (delta: number) => {
    const ws = getActiveWs();
    const st = ws ? pairs.get(ws.id) : undefined;
    if (!st || st.phase === "done") return;
    // coop の実装フェーズでは同期回数の上限を増減する
    if (st.kind === "coop" && st.building) {
      st.maxSync = Math.max(1, Math.min(PAIR_MAX_ROUNDS, st.maxSync + delta));
    } else {
      st.maxRounds = Math.max(1, Math.min(PAIR_MAX_ROUNDS, st.maxRounds + delta));
    }
    // 送信済みラウンドより下げた場合は、次の区切りで完了になる（=「今の作業で終わり」）
    updatePairStrip();
  };
  roundDecBtn.onclick = () => adjustRounds(-1);
  roundIncBtn.onclick = () => adjustRounds(1);
  turnBackBtn.onclick = () => {
    const ws = getActiveWs();
    const st = ws ? pairs.get(ws.id) : undefined;
    if (!st || st.phase !== "reviewTurn") return;
    // 誤って回ったターンを実装役へ引き戻す。何も自動送信せず、送ってしまった
    // レビュー依頼のラウンドは回数に数え直さない（レビュー役がこの後静止しても
    // phase が implTurn なのでフィードバックは送られない）
    st.round = Math.max(0, st.round - 1);
    st.phase = "implTurn";
    // 引き戻したレビュー依頼の Enter 再送・完了シグナルの受付も打ち切る
    st.pendingSubmits.delete(st.bId);
    st.pendingTurn.delete(st.bId);
    updatePairStrip();
  };
  promoteBtn.onclick = () => {
    const ws = getActiveWs();
    const st = ws ? pairs.get(ws.id) : undefined;
    if (st) promotePair(st);
  };
  handoffBtn.onclick = () => {
    const ws = getActiveWs();
    const st = ws ? pairs.get(ws.id) : undefined;
    if (st) performHandoff(st);
  };
  pauseBtn.onclick = () => {
    const ws = getActiveWs();
    const st = ws ? pairs.get(ws.id) : undefined;
    if (!st) return;
    st.paused = !st.paused;
    // 一時停止中に確認待ちのハンドオフや Enter 再送を持ち越さない
    // （再開後は次の busy→idle 遷移から仕切り直す）
    if (st.paused) clearPairTimers(st);
    updatePairStrip();
  };
  stopBtn.onclick = () => {
    const ws = getActiveWs();
    if (ws) stopPair(ws);
  };
  updatePairStrip();
}
