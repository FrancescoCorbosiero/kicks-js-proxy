import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["core/**/*.test.ts", "src/**/*.test.ts"],
  },
});
