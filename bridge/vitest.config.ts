import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import testKey from "./test/vapid-test-key.json" with { type: "json" };

export default defineConfig({
  plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // An empty collect waits out the hold. Tests should not.
      miniflare: {
        bindings: {
          POLL_HOLD_SECONDS: "1",
          // A signing key made for the tests, so the push path runs. The real one is a secret of the deployed Worker.
          VAPID_PUBLIC_KEY: testKey.publicKey,
          VAPID_PRIVATE_JWK: JSON.stringify(testKey.privateJwk),
          VAPID_SUBJECT: "https://example.test/easyotp",
        },
      },
    })],
  test: { include: ["test/**/*.spec.ts"] },
});
