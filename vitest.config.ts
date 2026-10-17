import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["shared/test/**/*.test.ts", "server/test/**/*.test.ts"],
    // Tests drive real agent processes; CI's Windows runners take several times longer than a dev machine.
    testTimeout: 60_000,
  },
});
