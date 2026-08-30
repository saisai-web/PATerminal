// ============================================================
// パス操作（正規化・親・結合・basename・表示用の短縮・シェル別の引用）
// OS 依存の判定（ドライブルート / 既定ルート / 引用符）は state.ts の hostOs を見る。
// ============================================================

import type { Pane } from "../../terminal/pane";
import { getHostOs } from "../../workspace/state";

/** 区切りを "/" に正規化し、末尾の余分な "/" を落とす（ルートは "/"・"C:/" の形を保つ） */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(s)) s += "/"; // "C:" → "C:/"
  return s;
}

/** OS のルート判定。Windows はドライブルートより上に出さない */
export function isFsRoot(p: string): boolean {
  return getHostOs() === "windows" ? /^[A-Za-z]:\/?$/.test(p) : p === "/";
}

export function parentPath(p: string): string | null {
  if (isFsRoot(p)) return null;
  const idx = p.lastIndexOf("/");
  if (getHostOs() === "windows") {
    return idx <= 2 ? `${p.slice(0, 2)}/` : p.slice(0, idx);
  }
  return idx <= 0 ? "/" : p.slice(0, idx);
}

export function joinPath(p: string, name: string): string {
  return (p.endsWith("/") ? p : `${p}/`) + name;
}

export function pathBasename(p: string): string {
  const cut = p.replace(/\/+$/, "");
  const seg = cut.slice(cut.lastIndexOf("/") + 1);
  return seg || p;
}

/** パスの末尾を最大2階層に縮める。短いパスはルート表記を含めてそのまま返す。 */
export function compactExplorerPath(p: string): string {
  const normalized = normPath(p);
  if (isFsRoot(normalized)) return normalized;
  const drive = normalized.match(/^([A-Za-z]:\/)(.*)$/);
  const root = drive?.[1] ?? (normalized.startsWith("/") ? "/" : "");
  const body = drive?.[2] ?? (root ? normalized.slice(1) : normalized);
  const parts = body.split("/").filter(Boolean);
  if (parts.length <= 2) return `${root}${parts.join("/")}`;
  return `…/${parts.slice(-2).join("/")}`;
}

/** お気に入り名の右側に出す親ディレクトリの文脈。 */
export function explorerParentContext(path: string): { text: string; full: string } {
  const normalized = normPath(path);
  const full = parentPath(normalized) ?? normalized;
  return { text: compactExplorerPath(full), full };
}

export function explorerPathContext(text: string, full: string): HTMLSpanElement {
  const context = document.createElement("span");
  context.className = "exp-row-path";
  context.textContent = text;
  context.title = full;
  return context;
}

/** 検索起点からの相対パス（配下ヒットの文脈表示用）。ルート直下は "." を返さない */
export function relativeFromCwd(parent: string, root: string): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  return parent.startsWith(base) ? parent.slice(base.length) : parent;
}

export function fsDefaultRoot(): string {
  return getHostOs() === "windows" ? "C:/" : "/";
}

export type ShellSyntax = "posix" | "powershell" | "cmd";

/** ペインのシェルの構文。spec.shell（明示指定）→ shellKind → ホスト OS の順で決める。
    terminal/pane.ts の shellForKind と対の関係だが、値 import は
    pane → sidebar → explorer → paths の実行時循環になるのでここに写してある。
    どちらかを変えたら両方見ること */
export function shellSyntaxFor(pane: Pane): ShellSyntax {
  const explicit = pane.spec.shell;
  if (explicit) {
    const stem = (explicit.split(/[\\/]/).pop() ?? explicit).toLowerCase().replace(/\.exe$/, "");
    if (stem === "cmd") return "cmd";
    if (stem === "powershell" || stem === "pwsh") return "powershell";
    return "posix"; // bash / zsh / fish など
  }
  if (pane.ws.shellKind === "cmd") return "cmd";
  if (pane.ws.shellKind === "powershell") return "powershell";
  // default シェルは Rust の default_shell() 任せ = Windows なら powershell.exe
  return getHostOs() === "windows" ? "powershell" : "posix";
}

/** フォーカス中ペインのシェルに合わせてパスを引用する */
export function quotePathFor(pane: Pane, path: string): string {
  switch (shellSyntaxFor(pane)) {
    case "cmd":
      return `"${path}"`;
    case "powershell":
      // PowerShell の "…" は $ とバッククォートを展開してしまう。'…' なら literal で、
      // エスケープは ' の二重化だけ
      return `'${path.replace(/'/g, "''")}'`;
    default:
      // POSIX シェルは ' で包む。Windows 上の Git Bash も来るので区切りを / に寄せる
      return `'${path.replace(/\\/g, "/").replace(/'/g, `'\\''`)}'`;
  }
}

/** そのシェルでディレクトリを移動するコマンド */
export function cdCommandFor(pane: Pane, path: string): string {
  const quoted = quotePathFor(pane, path);
  switch (shellSyntaxFor(pane)) {
    case "cmd":
      return `cd /d ${quoted}`; // cmd はドライブ跨ぎに /d が要る
    case "powershell":
      // 素の cd は [ ] をワイルドカードとして解釈するので、`.../[id]/` のような
      // 実在するパスで失敗する。-LiteralPath なら字面どおり移動する
      return `Set-Location -LiteralPath ${quoted}`;
    default:
      return `cd ${quoted}`;
  }
}
