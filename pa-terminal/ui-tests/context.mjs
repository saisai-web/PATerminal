export const results = [];
export const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}`);
};

// テスト本文は日本語 macOS の既存ベースラインを検証する。CI ランナーの OS / 言語に
// 結果を左右させず、別環境を検証したいときだけ環境変数で明示的に上書きする。
export const TEST_OS = process.env.PATERMINAL_TEST_OS ?? "macos";
export const TEST_LOCALE = process.env.PATERMINAL_TEST_LOCALE ?? "ja-JP";
export const MOD = TEST_OS === "macos" ? "Meta" : "Control";
export const BASE_URL = process.env.PATERMINAL_TEST_URL ?? "http://localhost:1420/";
