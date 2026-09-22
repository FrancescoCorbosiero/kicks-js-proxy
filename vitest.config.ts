import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
      // Next's server-only guard throws outside a server bundle — including
      // under vitest, which would fail any suite importing a server module.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["core/**/*.test.ts", "src/**/*.test.ts"],
  },
});
