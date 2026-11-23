import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // An empty collect waits out the hold. Tests should not.
      miniflare: { bindings: { POLL_HOLD_SECONDS: "1" } },
    })],
  test: { include: ["test/**/*.spec.ts"] },
});
