import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { execSync } from "node:child_process";

const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
})();

/**
 * This project builds two things from one set of parts.
 *
 *   vite build              the Receiver: the PWA, and the inside of its APK
 *   vite build --mode host  the Host app's screens, into the Host's assets
 *
 * The Host's screens go straight into the Android project, where Gradle packs
 * them into the APK (DECISIONS D19).
 */
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(commit) },
  build:
    mode === "host"
      ? {
          target: "es2022",
          sourcemap: false,
          outDir: "../host/src/main/assets/ui",
          emptyOutDir: true,
          // The Receiver's manifest, icons and service worker are not the Host's.
          copyPublicDir: false,
          rollupOptions: { input: "host.html" },
        }
      : { target: "es2022", sourcemap: false },
  test: { include: ["test/**/*.spec.ts"] },
}));
