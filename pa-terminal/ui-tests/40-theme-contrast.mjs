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
}
