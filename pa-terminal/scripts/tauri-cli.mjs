#!/usr/bin/env node
// @tauri-apps/cli の薄いラッパー（package.json の "tauri" スクリプト）。
// 引数はそのまま素通しし、`tauri build` が成功したときだけ、初回に限り
// サブスクの一言を1行出す（指示書 §自ビルド → サブスクの導線: 一度きり・静か。
// これ以外の誘導・遅延・機能制限をここに足すことは禁止）。
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const child = spawn("tauri", args, { stdio: "inherit", shell: true });
child.on("exit", (code) => {
  if (code === 0 && args[0] === "build") {
    const marker = path.join(homedir(), ".paterminal-build-thanks");
    if (!existsSync(marker)) {
      try {
        writeFileSync(marker, new Date().toISOString() + "\n");
        console.log(
          "Build成功。役に立ったらサブスクが開発を支えます（このビルドでもキーは使えます）",
        );
      } catch {
        /* マーカーが書けない環境では何も出さない */
      }
    }
  }
  process.exit(code ?? 0);
});
