import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/electron/main.ts",
      fileName: () => "main.cjs",
      formats: ["cjs"]
    },
    rollupOptions: {
      external: ["electron"]
    }
  }
});
