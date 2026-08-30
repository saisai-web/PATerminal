// ============================================================
// ツリー操作
// ============================================================

import { setFocused } from "./focus";
import { layout } from "./layout";
import { makePane } from "./pane";
import type { Pane } from "./pane";
import { scheduleSave } from "../app/session";
import { MAX_RATIO, MIN_RATIO } from "../shared/constants";
import { FREE_PANE_LIMIT, requireFeature } from "../features/license/license";
import { renderLockMarks } from "../features/license/lock-marks";
import { getActiveWs } from "../workspace/state";
import type { PaneSpec, Workspace } from "../workspace/types";

export type TreeNode =
  | { kind: "leaf"; pane: Pane }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: TreeNode; b: TreeNode };

export type SplitNode = Extract<TreeNode, { kind: "split" }>;

/** spec 配列から左右交互に半分ずつ割ってバランス木を作る */
export function buildTree(ws: Workspace, specs: PaneSpec[], dir: "row" | "col" = "row"): TreeNode {
  if (specs.length === 1) return { kind: "leaf", pane: makePane(ws, specs[0]) };
  const mid = Math.ceil(specs.length / 2);
  const next = dir === "row" ? "col" : "row";
  return {
    kind: "split",
    dir,
    ratio: mid / specs.length,
    a: buildTree(ws, specs.slice(0, mid), next),
    b: buildTree(ws, specs.slice(mid), next),
  };
}

export function findParent(
  node: TreeNode,
  id: string,
  parent: Extract<TreeNode, { kind: "split" }> | null = null,
): { leaf: Extract<TreeNode, { kind: "leaf" }>; parent: typeof parent } | null {
  if (node.kind === "leaf") {
    return node.pane.id === id ? { leaf: node, parent } : null;
  }
  return findParent(node.a, id, node) ?? findParent(node.b, id, node);
}

export function splitPane(ws: Workspace, id: string, dir: "row" | "col", spec?: PaneSpec) {
  if (!ws.root) return;
  // ソフトロック: 無料枠はペイン2枚まで。3枚目以降の「新たな分割」だけをブロックする
  // （restoreTree はここを通らないため、3枚以上の保存済みセッションの復元は無傷。
  // ツールバー・ショートカット・エクスプローラー・ペアの全分割経路がここを通る）
  if (ws.panes.size >= FREE_PANE_LIMIT && !requireFeature()) return;
  const base = ws.panes.get(id);
  if (!base) return;

  // 分割は「フォーカス leaf の2分割」ではなく「レイアウト全体への追加」:
  // ルートを新しい split で包むので、下分割は既存の全ペインを横断する全幅の下段、
  // 横分割は全高の右列になる（例: 横並び2枚 + 下分割 → col(row(a,b), c)）。
  // ratio は既存ペイン数ベースで、新ペインが 1/(n+1) を得る（1枚なら従来どおり半分）
  const n = ws.panes.size;
  const newLeaf: TreeNode = {
    kind: "leaf",
    pane: makePane(ws, spec ?? { title: "shell", cwd: base.cwd }),
  };
  ws.root = {
    kind: "split",
    dir,
    ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, n / (n + 1))),
    a: ws.root,
    b: newLeaf,
  };
  layout(ws);
  setFocused((newLeaf as Extract<TreeNode, { kind: "leaf" }>).pane.id);
  renderLockMarks(); // 分割ボタンの 🔒 はペイン数条件つき（2枚まで無料）
  scheduleSave();
}

/** ペインのシェル（や実行中のプロセス）を終了し、同じ位置に真新しいシェルを起動し直す。
    新規セッションの初期ペインと同じ状態にする（ペインバーのゴミ箱ボタン）。 */
export async function restartPane(ws: Workspace, id: string) {
  if (!ws.root) return;
  const found = findParent(ws.root, id);
  if (!found) return;

  const old = found.leaf.pane;
  // resumeShell/resumeArgs/resumeRun/agent は「アプリ再起動時の再開」専用フィールドなので
  // 引き継がない（新規セッションの spec と同じ形にする）。cwd は現在地（OSC 7 で追跡した
  // this.cwd）を優先し、無ければ起動時の spec.cwd にフォールバックする
  const spec: PaneSpec = {
    title: old.spec.title,
    shell: old.spec.shell,
    args: old.spec.args,
    cwd: old.cwd ?? old.spec.cwd,
    run: old.spec.run,
  };

  await old.destroy();
  const fresh = makePane(ws, spec);
  found.leaf.pane = fresh;

  layout(ws);
  if (ws === getActiveWs()) setFocused(fresh.id);
  scheduleSave();
}

export async function closePane(ws: Workspace, id: string) {
  if (!ws.root) return;
  // 最後の1枚は閉じられない（ボタンも layout() の .single-pane で非表示にしている。
  // セッションごと閉じたいときはサイドバーの × を使う）
  if (ws.root.kind === "leaf") return;
  const found = findParent(ws.root, id);
  if (!found) return;

  const pane = found.leaf.pane;
  await pane.destroy();

  if (!found.parent) {
    // ここには来ない（root が leaf の場合は冒頭で弾いている）が、保険で空にしない
    ws.root = { kind: "leaf", pane: makePane(ws, { title: "shell" }) };
  } else {
    const sibling = found.parent.a === found.leaf ? found.parent.b : found.parent.a;
    const grand = ws.root.kind === "split" ? findSplitParent(ws.root, found.parent) : null;
    if (!grand) {
      ws.root = sibling;
    } else if (grand.a === found.parent) {
      grand.a = sibling;
    } else {
      grand.b = sibling;
    }
  }
  layout(ws);
  if (ws === getActiveWs()) {
    const first = firstLeaf(ws.root);
    if (first) setFocused(first.pane.id);
  }
  renderLockMarks(); // ペイン数が減ると分割ボタンの 🔒 が外れることがある
  scheduleSave();
}

export function findSplitParent(
  node: TreeNode,
  target: TreeNode,
): Extract<TreeNode, { kind: "split" }> | null {
  if (node.kind === "leaf") return null;
  if (node.a === target || node.b === target) return node;
  return findSplitParent(node.a, target) ?? findSplitParent(node.b, target);
}

export function firstLeaf(node: TreeNode | null): Extract<TreeNode, { kind: "leaf" }> | null {
  if (!node) return null;
  if (node.kind === "leaf") return node;
  return firstLeaf(node.a);
}
