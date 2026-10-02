import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` -> `./*` mapping in tsconfig.json so tests import modules by the
    // same specifier the application uses. Without this, a test that imports `@/lib/...`
    // would pass typecheck but fail to resolve at runtime — a divergence worth removing.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // `server-only` throws outside a React Server Component graph, which would stop a test
      // from importing a route handler that transitively reaches Prisma. Substituted with an
      // empty stub for tests only; the app still gets the real guard.
      "server-only": fileURLToPath(new URL("./test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
