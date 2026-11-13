import { svelte } from "@sveltejs/vite-plugin-svelte";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      src: "/src",
    },
    conditions: ["browser"],
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "server/entity/**",
      "server/native/**",
      "server/runtime/**",
      "server/browser/**",
    ],
    environment: "happy-dom",
    setupFiles: ["vitest.setup.ts"],
  },
});
