// 5テーマの配色契約。claude / codex の TUI は ANSI の通常色・明色・反転背景を
// 組み合わせるため、パレットの欠落と低コントラストを数値で回帰検証する。
export default async function themeContrastSuite({ page, check }) {
  const audit = await page.evaluate(async () => {
    const themeModule = await import("/src/features/settings/themes.ts");
    const stateModule = await import("/src/workspace/state.ts");
    const { THEMES, XTERM_MINIMUM_CONTRAST_RATIO } = themeModule;

    const luminance = (hex) => {
      const channels = hex.slice(1).match(/../g)
        .map((part) => parseInt(part, 16) / 255)
        .map((value) => value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (a, b) => {
      const aLum = luminance(a);
      const bLum = luminance(b);
      return (Math.max(aLum, bLum) + 0.05) / (Math.min(aLum, bLum) + 0.05);
    };

    const ansiKeys = [
      "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
      "brightBlack", "brightRed", "brightGreen", "brightYellow",
      "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
    ];
    const requiredTerminalKeys = [
      "background", "foreground", "cursor", "cursorAccent",
      "selectionBackground", "selectionForeground", "selectionInactiveBackground",
      ...ansiKeys,
    ];
    const failures = [];

    for (const theme of THEMES) {
      for (const key of requiredTerminalKeys) {
        if (!theme.xterm[key]) failures.push(`${theme.id}: missing xterm.${key}`);
      }

      for (const foreground of ["text", "dim", "accent", "alarm"]) {
        for (const background of ["bg", "chrome", "pane-bg"]) {
          const ratio = contrast(theme.ui[foreground], theme.ui[background]);
          if (ratio < 4.5) failures.push(
            `${theme.id}: ${foreground}/${background}=${ratio.toFixed(2)}`,
          );
        }
      }

      const pairedColors = [
        ["on-accent/accent", theme.ui["on-accent"], theme.ui.accent, 4.5],
        ["on-accent/alarm", theme.ui["on-accent"], theme.ui.alarm, 4.5],
        ["diff-add", theme.ui["diff-add-fg"], theme.ui["diff-add-bg"], 4.5],
        ["diff-del", theme.ui["diff-del-fg"], theme.ui["diff-del-bg"], 4.5],
        ["terminal foreground", theme.xterm.foreground, theme.xterm.background, 4.5],
        ["terminal cursor", theme.xterm.cursor, theme.xterm.cursorAccent, 4.5],
        ["terminal selection", theme.xterm.selectionForeground,
          theme.xterm.selectionBackground, 4.5],
        ["focus border", theme.ui["focus-border"], theme.ui["pane-bg"], 3],
      ];
      for (const [label, foreground, background, minimum] of pairedColors) {
        const ratio = contrast(foreground, background);
        if (ratio < minimum) failures.push(`${theme.id}: ${label}=${ratio.toFixed(2)}`);
      }
    }

    const livePane = Array.from(stateModule.panes.values())[0];
    return {
      failures,
      themeCount: THEMES.length,
      configuredMinimum: XTERM_MINIMUM_CONTRAST_RATIO,
      liveMinimum: livePane?.term.options.minimumContrastRatio,
    };
  });

  check("all five themes define complete, high-contrast palettes",
    audit.themeCount === 5 && audit.failures.length === 0,
    audit.failures.join("; "));
  check("live terminals enforce the configured ANSI contrast floor",
    audit.configuredMinimum === 5 && audit.liveMinimum === audit.configuredMinimum,
    `configured=${audit.configuredMinimum} live=${audit.liveMinimum}`);

  // ターミナルのスクロールバーは、どのテーマでもレール（トラック）がペイン背景と
  // 区別でき、つまみがレールから浮いて見えること。トラックがペイン背景と同色だと
  // 末尾表示中は右下のつまみ 1 本しか見えず「スクロールバーがない」ように見える
  // （Issue #24）。::-webkit-scrollbar 系の計算値は Chrome / WebKit とも
  // getComputedStyle(el, pseudo) で読める。
  const scrollbar = await page.evaluate(async () => {
    const { THEMES, applyThemeCss } = await import("/src/features/settings/themes.ts");
    const { getTheme } = await import("/src/features/settings/settings-panel.ts");
    const viewport = document.querySelector(".pane-body .xterm .xterm-viewport");
    if (!viewport) return null;

    // Chrome は color-mix() の計算値を color(srgb r g b)（0〜1）で返し、固定色は
    // rgb(r, g, b)（0〜255）で返す。テーマ定義の #rrggbb も含めて 0〜1 に正規化する。
    const luminance = (color) => {
      const match = color.startsWith("#")
        ? color.slice(1).match(/../g)?.map((part) => String(parseInt(part, 16)))
        : color.match(/[\d.]+/g);
      if (!match || match.length < 3) return null;
      const scale = color.startsWith("color(") ? 1 : 255;
      const channels = match.slice(0, 3)
        .map((part) => Number(part) / scale)
        .map((value) => value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (a, b) => {
      const aLum = luminance(a);
      const bLum = luminance(b);
      if (aLum === null || bLum === null) return 0;
      return (Math.max(aLum, bLum) + 0.05) / (Math.min(aLum, bLum) + 0.05);
    };

    const original = getTheme();
    const failures = [];
    const measured = [];
    try {
      for (const theme of THEMES) {
        applyThemeCss(theme.id);
        // viewport の背景は xterm がテーマ option から塗るため CSS 変数の切替に追随しない。
        // 実機ではテーマの pane-bg と一致するので、そちらと比較する。
        const paneBg = theme.ui["pane-bg"];
        const track = getComputedStyle(viewport, "::-webkit-scrollbar-track");
        const thumb = getComputedStyle(viewport, "::-webkit-scrollbar-thumb");
        const bar = getComputedStyle(viewport, "::-webkit-scrollbar");
        const railRatio = contrast(track.backgroundColor, paneBg);
        const thumbRatio = contrast(thumb.backgroundColor, track.backgroundColor);
        measured.push(`${theme.id}: rail=${railRatio.toFixed(2)} thumb=${thumbRatio.toFixed(2)} width=${bar.width}`);
        if (bar.width !== "14px") failures.push(`${theme.id}: scrollbar width=${bar.width}`);
        if (railRatio < 1.1) failures.push(`${theme.id}: rail/pane-bg=${railRatio.toFixed(2)}`);
        if (thumbRatio < 3) failures.push(`${theme.id}: thumb/rail=${thumbRatio.toFixed(2)}`);
        if (track.borderLeftWidth === "0px") failures.push(`${theme.id}: rail has no edge line`);
      }
    } finally {
      applyThemeCss(original);
    }
    return { failures, measured };
  });

  check("the terminal scrollbar rail and thumb stay visible in every theme",
    !!scrollbar && scrollbar.failures.length === 0,
    scrollbar ? (scrollbar.failures.join("; ") || scrollbar.measured.join("; ")) : "xterm viewport missing");
}
