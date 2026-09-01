import type { ITheme } from "@xterm/xterm";

// カラーテーマのプリセット定義。ui は styles.css の :root 変数（-- なし）に、
// xterm は各ペインの Terminal.options.theme にそのまま入る。
// ui の全キーは全プリセット必須（欠けると前のテーマの色が残る）。

export type ThemeId = "dark" | "light" | "solarized-dark" | "dracula" | "nord";

type RequiredXtermColor =
  | "background"
  | "foreground"
  | "cursor"
  | "cursorAccent"
  | "selectionBackground"
  | "selectionForeground"
  | "selectionInactiveBackground"
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/**
 * TUI が使う色を xterm の既定パレットへ退避させない完全なテーマ。
 * claude / codex は通常色・明色・反転背景を広く使うため、全色を必須にする。
 */
export type TerminalTheme = ITheme & Required<Pick<ITheme, RequiredXtermColor>>;

export type ThemePreset = {
  id: ThemeId;
  /** テーマ名は固有名詞なので翻訳しない */
  label: string;
  ui: Record<string, string>;
  xterm: TerminalTheme;
};

export const DEFAULT_THEME: ThemeId = "dark";

/**
 * ANSI 前景色とセル背景色が近い場合、描画時に前景色を補正する下限。
 * 13px の通常文字でも輪郭が明確になるよう WCAG AA (4.5) より少し余裕を持たせる。
 */
export const XTERM_MINIMUM_CONTRAST_RATIO = 5;

const UI_KEYS = [
  "bg",
  "chrome",
  "line",
  "text",
  "dim",
  "accent",
  "alarm",
  "hover",
  "active-bg",
  "pane-bg",
  "focus-border",
  "pulse",
  "on-accent",
  "shadow",
  "diff-add-bg",
  "diff-add-fg",
  "diff-del-bg",
  "diff-del-fg",
  "ws-color-red",
  "ws-color-orange",
  "ws-color-yellow",
  "ws-color-green",
  "ws-color-blue",
  "ws-color-purple",
] as const;

export const THEMES: ThemePreset[] = [
  {
    id: "dark",
    label: "Dark",
    ui: {
      bg: "#07090b",
      chrome: "#11151a",
      line: "#1e252d",
      text: "#d6dbe0",
      dim: "#7f8c99",
      accent: "#6ee7d0",
      alarm: "#f0a04b",
      hover: "#171c22",
      "active-bg": "#1a2027",
      "pane-bg": "#0d1013",
      "focus-border": "#526273",
      pulse: "#7a5528",
      "on-accent": "#07090b",
      shadow: "rgba(0, 0, 0, 0.5)",
      "diff-add-bg": "#12351f",
      "diff-add-fg": "#7ee787",
      "diff-del-bg": "#47201f",
      "diff-del-fg": "#ff8f88",
      "ws-color-red": "#e06c75",
      "ws-color-orange": "#e5a55b",
      "ws-color-yellow": "#d9c07c",
      "ws-color-green": "#8cc265",
      "ws-color-blue": "#61afef",
      "ws-color-purple": "#c678dd",
    },
    xterm: {
      background: "#0d1013",
      foreground: "#d6dbe0",
      cursor: "#6ee7d0",
      cursorAccent: "#07090b",
      selectionBackground: "#34404c",
      selectionForeground: "#f4f7fa",
      selectionInactiveBackground: "#202933",
      black: "#3b4652",
      red: "#e06c75",
      green: "#8cc265",
      yellow: "#d9c07c",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#d6dbe0",
      brightBlack: "#8995a1",
      brightRed: "#ff7b86",
      brightGreen: "#a7d982",
      brightYellow: "#f0d58d",
      brightBlue: "#7cc4ff",
      brightMagenta: "#dc91ef",
      brightCyan: "#72d1dc",
      brightWhite: "#f4f7fa",
    },
  },
  {
    id: "light",
    label: "Light",
    ui: {
      bg: "#f4f5f6",
      chrome: "#e9ebee",
      line: "#d0d5da",
      text: "#24292f",
      dim: "#586573",
      accent: "#087568",
      alarm: "#9a4308",
      hover: "#dde1e6",
      "active-bg": "#d2d8de",
      "pane-bg": "#ffffff",
      "focus-border": "#7b8e9d",
      pulse: "#e0b880",
      "on-accent": "#ffffff",
      shadow: "rgba(0, 0, 0, 0.2)",
      "diff-add-bg": "#e6ffec",
      "diff-add-fg": "#1a7f37",
      "diff-del-bg": "#ffebe9",
      "diff-del-fg": "#cf222e",
      "ws-color-red": "#cf222e",
      "ws-color-orange": "#bc6b00",
      "ws-color-yellow": "#9a7b00",
      "ws-color-green": "#1a7f37",
      "ws-color-blue": "#0969da",
      "ws-color-purple": "#8250df",
    },
    xterm: {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#087568",
      cursorAccent: "#ffffff",
      selectionBackground: "#b7c6d5",
      selectionForeground: "#17212b",
      selectionInactiveBackground: "#d8e0e8",
      black: "#24292f",
      red: "#b42318",
      green: "#247619",
      yellow: "#735c00",
      blue: "#055cc4",
      magenta: "#6f42c1",
      cyan: "#006d77",
      white: "#5e6975",
      brightBlack: "#424b55",
      brightRed: "#d1242f",
      brightGreen: "#1a7f37",
      brightYellow: "#8a6900",
      brightBlue: "#0969da",
      brightMagenta: "#8250df",
      brightCyan: "#087f8c",
      brightWhite: "#343a40",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    ui: {
      bg: "#00212b",
      chrome: "#073642",
      line: "#0e4a5a",
      text: "#93a1a1",
      dim: "#8e9fa2",
      accent: "#35b5aa",
      alarm: "#ef7d45",
      hover: "#0a3540",
      "active-bg": "#0e4250",
      "pane-bg": "#002b36",
      "focus-border": "#268bd2",
      pulse: "#6a3a12",
      "on-accent": "#002b36",
      shadow: "rgba(0, 0, 0, 0.5)",
      "diff-add-bg": "#0a3d2e",
      "diff-add-fg": "#b4c938",
      "diff-del-bg": "#3d1a14",
      "diff-del-fg": "#ff786f",
      "ws-color-red": "#dc322f",
      "ws-color-orange": "#cb4b16",
      "ws-color-yellow": "#b58900",
      "ws-color-green": "#859900",
      "ws-color-blue": "#268bd2",
      "ws-color-purple": "#d33682",
    },
    xterm: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#35b5aa",
      cursorAccent: "#002b36",
      selectionBackground: "#0e4a5a",
      selectionForeground: "#eee8d5",
      selectionInactiveBackground: "#073642",
      black: "#586e75",
      red: "#f15b50",
      green: "#9fb300",
      yellow: "#d3a91a",
      blue: "#48a8e8",
      magenta: "#ed5aa6",
      cyan: "#35b5aa",
      white: "#eee8d5",
      brightBlack: "#8e9fa2",
      brightRed: "#ff786f",
      brightGreen: "#b4c938",
      brightYellow: "#f2c94c",
      brightBlue: "#70bff0",
      brightMagenta: "#ff7fba",
      brightCyan: "#68d1c5",
      brightWhite: "#fff7df",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    ui: {
      bg: "#21222c",
      chrome: "#282a36",
      line: "#44475a",
      text: "#f8f8f2",
      dim: "#8996c5",
      accent: "#bd93f9",
      alarm: "#ffb86c",
      hover: "#343746",
      "active-bg": "#3c3f51",
      "pane-bg": "#282a36",
      "focus-border": "#bd93f9",
      pulse: "#8a5a30",
      "on-accent": "#21222c",
      shadow: "rgba(0, 0, 0, 0.5)",
      "diff-add-bg": "#1d3a2a",
      "diff-add-fg": "#50fa7b",
      "diff-del-bg": "#3c2130",
      "diff-del-fg": "#ff5555",
      "ws-color-red": "#ff5555",
      "ws-color-orange": "#ffb86c",
      "ws-color-yellow": "#f1fa8c",
      "ws-color-green": "#50fa7b",
      "ws-color-blue": "#8be9fd",
      "ws-color-purple": "#bd93f9",
    },
    xterm: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#21222c",
      selectionBackground: "#44475a",
      selectionForeground: "#ffffff",
      selectionInactiveBackground: "#343746",
      black: "#44475a",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#8996c5",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    label: "Nord",
    ui: {
      bg: "#242933",
      chrome: "#2e3440",
      line: "#3b4252",
      text: "#d8dee9",
      dim: "#96a3b8",
      accent: "#88c0d0",
      alarm: "#dc927a",
      hover: "#333a47",
      "active-bg": "#3b4252",
      "pane-bg": "#2e3440",
      "focus-border": "#81a1c1",
      pulse: "#6d4a3a",
      "on-accent": "#2e3440",
      shadow: "rgba(0, 0, 0, 0.5)",
      "diff-add-bg": "#2e4238",
      "diff-add-fg": "#a3be8c",
      "diff-del-bg": "#452c31",
      "diff-del-fg": "#e1848c",
      "ws-color-red": "#bf616a",
      "ws-color-orange": "#d08770",
      "ws-color-yellow": "#ebcb8b",
      "ws-color-green": "#a3be8c",
      "ws-color-blue": "#81a1c1",
      "ws-color-purple": "#b48ead",
    },
    xterm: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      selectionForeground: "#eceff4",
      selectionInactiveBackground: "#3b4252",
      black: "#4c566a",
      red: "#e1848c",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#c39bbd",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#96a3b8",
      brightRed: "#f0969e",
      brightGreen: "#b7d7a0",
      brightYellow: "#f7dba0",
      brightBlue: "#9fc5e8",
      brightMagenta: "#d8b4d3",
      brightCyan: "#a4d8e3",
      brightWhite: "#f4f7fb",
    },
  },
];

export function themeById(id: string | undefined): ThemePreset {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

export function xtermThemeFor(id: ThemeId): ITheme {
  return themeById(id).xterm;
}

/** :root の CSS 変数を書き換えて UI 全体を再着色する */
export function applyThemeCss(id: ThemeId): ThemePreset {
  const preset = themeById(id);
  const style = document.documentElement.style;
  for (const key of UI_KEYS) style.setProperty(`--${key}`, preset.ui[key]);
  return preset;
}
