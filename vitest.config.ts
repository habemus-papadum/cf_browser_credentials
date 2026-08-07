import { defineConfig } from "vitest/config";

// Aggregate every workspace package as a Vitest project; each package supplies its
// own vite.config.ts. `vitest run` at the root runs the whole monorepo at once.
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
