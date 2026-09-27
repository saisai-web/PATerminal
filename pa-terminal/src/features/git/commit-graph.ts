// コミットグラフのレーン割り当てと、1行ぶんの SVG 描画。
//
// git_log は日付順（--date-order）で親の完全ハッシュつきのコミットを返す。上から順に
// 「各レーンが次に待っているコミット」を持ち回し、行ごとに
//   - 上半分: その行に入ってくる線（通過するレーン / このコミットへ合流するレーン）
//   - 下半分: その行から出ていく線（通過するレーン / 親へ向かうレーン）
// を描く。レーンは途中で詰めない（列が動くと線が斜めに走って読みにくいため）。
// 空いた列は次に始まる線が再利用し、末尾の空き列だけ落とす。
//
// 色は CSS 変数（--graph-N）で持ち、テーマ切替に追従させる（hex ハードコード禁止）。

export type GraphInput = { id: string; parents: string[] };

type Edge = { from: number; to: number; color: number };

export type GraphRow = {
  /** このコミットのノードを置く列 */
  col: number;
  /** ノードの色番号 */
  color: number;
  /** 上半分の線（from: 行の上端の列 → to: 中央の列） */
  top: Edge[];
  /** 下半分の線（from: 中央の列 → to: 行の下端の列） */
  bottom: Edge[];
  /** この行で使っている列数（SVG の幅） */
  width: number;
};

export const GRAPH_COLORS = 8;

type Lane = { id: string; color: number } | null;

export function layoutGraph(commits: GraphInput[]): GraphRow[] {
  const known = new Set(commits.map((c) => c.id));
  let lanes: Lane[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const freeSlot = (): number => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };

  for (const c of commits) {
    const before = lanes.slice();
    let col = before.findIndex((l) => l?.id === c.id);
    let color: number;
    if (col === -1) {
      // どのレーンも待っていない = ブランチの先端。空き列から新しい線を始める
      col = freeSlot();
      color = nextColor++ % GRAPH_COLORS;
    } else {
      color = before[col]!.color;
    }

    const top: Edge[] = [];
    before.forEach((l, i) => {
      if (!l) return;
      top.push({ from: i, to: l.id === c.id ? col : i, color: l.color });
    });

    // このコミットを待っていたレーンはここで合流して閉じる
    lanes = before.map((l) => (l && l.id === c.id ? null : l));
    while (lanes.length <= col) lanes.push(null);

    const bottom: Edge[] = [];
    // 読み込み範囲外の親は線を伸ばさない（最下段で途切れて見えるだけにする）
    const parents = c.parents.filter((p) => known.has(p));
    parents.forEach((p, n) => {
      const existing = lanes.findIndex((l) => l?.id === p);
      if (existing !== -1) {
        // 別レーンがすでにその親を待っている → そこへ合流する線
        bottom.push({ from: col, to: existing, color: n === 0 ? color : lanes[existing]!.color });
        return;
      }
      if (n === 0) {
        lanes[col] = { id: p, color };
        bottom.push({ from: col, to: col, color });
        return;
      }
      // マージの2本目以降の親は新しいレーンを開く
      const slot = freeSlot();
      const lane = { id: p, color: nextColor++ % GRAPH_COLORS };
      if (slot === lanes.length) lanes.push(lane);
      else lanes[slot] = lane;
      bottom.push({ from: col, to: slot, color: lane.color });
    });
    lanes.forEach((l, i) => {
      if (l && i !== col && before[i]?.id === l.id) bottom.push({ from: i, to: i, color: l.color });
    });

    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    const width = Math.max(before.length, lanes.length, col + 1);
    rows.push({ col, color, top, bottom, width });
  }
  return rows;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** 1列の幅（px） */
export const LANE_W = 10;
/** 描画する最大列数。これを超える列は描かない（さらに CSS でパネル幅の一定割合に切り詰める） */
export const MAX_LANES = 10;

const laneX = (i: number): number => LANE_W / 2 + i * LANE_W;

function segment(x1: number, y1: number, x2: number, y2: number, color: number): SVGPathElement {
  const path = document.createElementNS(SVG_NS, "path");
  // 列をまたぐ線は S 字のカーブにする
  const d =
    x1 === x2
      ? `M${x1} ${y1}V${y2}`
      : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  path.setAttribute("d", d);
  path.setAttribute("class", `graph-line graph-c${color}`);
  return path;
}

/** 表示中の全行で共通のグラフ列の列数（SourceTree と同じく本文の左端を揃えるため） */
export function graphLanes(rows: GraphRow[]): number {
  return Math.min(MAX_LANES, rows.reduce((m, r) => Math.max(m, r.width), 1));
}

/** 1行ぶんのグラフ SVG。全行を同じ幅（lanes 列）で描き、行の上下端で線がつながる */
export function renderGraphCell(
  row: GraphRow,
  lanes: number,
  height: number,
  opts: { head: boolean; merge: boolean },
): SVGSVGElement {
  const w = lanes * LANE_W;
  const mid = height / 2;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "git-graph");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${w} ${height}`);
  svg.setAttribute("aria-hidden", "true");
  for (const e of row.top) svg.append(segment(laneX(e.from), 0, laneX(e.to), mid, e.color));
  for (const e of row.bottom) svg.append(segment(laneX(e.from), mid, laneX(e.to), height, e.color));
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(laneX(row.col)));
  dot.setAttribute("cy", String(mid));
  dot.setAttribute("r", opts.head ? "4.2" : opts.merge ? "3" : "3.6");
  dot.setAttribute(
    "class",
    `graph-dot graph-c${row.color}${opts.head ? " is-head" : ""}${opts.merge ? " is-merge" : ""}`,
  );
  svg.append(dot);
  return svg;
}
