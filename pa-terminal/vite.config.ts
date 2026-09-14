import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Cargo loads/rewrites DLLs in target on Windows. Watching them can make
      // Vite exit with EBUSY while `tauri dev` is still compiling the app.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
  },
});
