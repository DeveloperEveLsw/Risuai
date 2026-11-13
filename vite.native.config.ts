import { defineConfig } from "vite";
import strip from "@rollup/plugin-strip";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [strip({ include: "**/*.(mjs|js|ts)" })],
  resolve: {
    conditions: ["node"],
    alias: { src: fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    ssr: "src/ts/runtime/nativeExtensionJob.ts",
    target: "node22",
    outDir: "server/native/dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { output: { entryFileNames: "extensionJob.mjs" } },
  },
});
