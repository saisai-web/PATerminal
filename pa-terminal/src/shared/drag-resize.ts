// モーダルの大きさ・列幅をハンドルのドラッグで変えるための共通部（diff オーバーレイと Git ウィンドウ）。
// 変えた値は閲覧者ごとの利便として localStorage に残す（無くても既定で開く）。
// ここからは layout()/refit や pty_resize に触れない（ターミナルの上に重なるモーダルだけが対象）。

export type PanelSize = { w: number; h: number };

export const isPanelSize = (v: unknown): v is PanelSize =>
  !!v && Number.isFinite((v as PanelSize).w) && Number.isFinite((v as PanelSize).h);
export const isWidth = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function loadStored<T>(key: string, valid: (v: unknown) => v is T): T | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (valid(v)) return v;
  } catch {
    /* 既定の大きさで開く */
  }
  return null;
}

export function saveStored(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても今回の表示には影響しない */
  }
}

/** ハンドルのドラッグ共通部: 押している間 move を呼び、離したら done を呼ぶ */
export function dragGrip(down: PointerEvent, move: (dx: number, dy: number) => void, done: () => void): void {
  down.preventDefault();
  const grip = down.currentTarget as HTMLElement;
  try {
    grip.setPointerCapture(down.pointerId);
  } catch {
    /* キャプチャ不可でも move は届く範囲で動く */
  }
  const onMove = (e: PointerEvent) => move(e.clientX - down.clientX, e.clientY - down.clientY);
  const up = () => {
    grip.removeEventListener("pointermove", onMove);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    done();
  };
  grip.addEventListener("pointermove", onMove);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

/**
 * 画面中央に置いたモーダルへ、右辺・下辺・右下の角の大きさ変更ハンドルを付ける。
 * 大きさは `${cssVar}-w` / `${cssVar}-h` と .is-sized で当て、画面に収める上限は CSS 側で掛ける。
 * ダブルクリックで既定の大きさへ戻す。
 */
export function attachPanelResize(
  panel: HTMLElement,
  opts: { key: string; cssVar: string; minW: number; minH: number },
): void {
  let size = loadStored(opts.key, isPanelSize);
  const apply = (): void => {
    panel.classList.toggle("is-sized", !!size);
    if (!size) return;
    panel.style.setProperty(`${opts.cssVar}-w`, `${Math.max(opts.minW, size.w)}px`);
    panel.style.setProperty(`${opts.cssVar}-h`, `${Math.max(opts.minH, size.h)}px`);
  };
  for (const axis of ["x", "y", "xy"] as const) {
    const g = document.createElement("div");
    g.className = `panel-grip is-${axis}`;
    g.setAttribute("aria-hidden", "true");
    g.addEventListener("pointerdown", (down) => {
      const startW = panel.offsetWidth;
      const startH = panel.offsetHeight;
      dragGrip(
        down,
        (dx, dy) => {
          // モーダルは画面中央に置いたままなので、辺がポインターに付いてくるよう差分の2倍を足す
          size = {
            w: axis === "y" ? startW : startW + dx * 2,
            h: axis === "x" ? startH : startH + dy * 2,
          };
          apply();
        },
        () => {
          // 画面に収めた後の実寸を残す
          size = { w: panel.offsetWidth, h: panel.offsetHeight };
          apply();
          saveStored(opts.key, size);
        },
      );
    });
    g.addEventListener("dblclick", () => {
      size = null;
      apply();
      saveStored(opts.key, null);
    });
    panel.append(g);
  }
  apply();
}

/**
 * 左の列（side）の幅を、その端のハンドルで変えられるようにする。幅は container の
 * `cssVar` と `sizedClass` で当て、下限と本文側に残す幅は CSS の clamp で掛ける。
 * 同じ key の列（開き直した差分など）は直近の幅を引き継ぐ。ダブルクリックで既定へ戻す。
 */
export function attachSideResize(
  container: HTMLElement,
  side: HTMLElement,
  opts: { key: string; cssVar: string; sizedClass: string; gripClass: string },
): void {
  const apply = (width: number | null): void => {
    container.classList.toggle(opts.sizedClass, width !== null);
    if (width !== null) container.style.setProperty(opts.cssVar, `${width}px`);
  };
  const grip = document.createElement("div");
  grip.className = opts.gripClass;
  grip.setAttribute("aria-hidden", "true");
  grip.addEventListener("pointerdown", (down) => {
    const startW = side.offsetWidth;
    // 右から左の言語では列が右側に来るので、引く向きを反転する
    const sign = getComputedStyle(container).direction === "rtl" ? -1 : 1;
    dragGrip(
      down,
      (dx) => apply(startW + dx * sign),
      () => {
        // 上限・下限に収めた後の実寸を残す
        const width = side.offsetWidth;
        apply(width);
        saveStored(opts.key, width);
      },
    );
  });
  grip.addEventListener("dblclick", () => {
    apply(null);
    saveStored(opts.key, null);
  });
  side.append(grip);
  apply(loadStored(opts.key, isWidth));
}
