/// <reference types="@cloudflare/vitest-plugin/types" />

// Tells the test runtime what the Worker exports, so `exports.default.fetch`
// in a test is typed against the real entry point.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/worker");
  }
  interface Env extends import("../src/worker").Env {}
}
