/**
 * The bridges, as they stood when this was built (DECISIONS D17). Must match
 * SEED_BRIDGES in the Host's Settings.kt. A signed list that replaces this
 * without a new build is not built yet.
 */
const LIVE = ["https://easyotp.arsalan.finlawgpt.ir", "https://easyotp.cfworker.rhinocloud.ir"];

/**
 * A development build can be pointed at other bridges, which is how the
 * end-to-end test runs against a bridge on this machine. A released build
 * cannot: the variable is only read when the build is a development one.
 */
const override = import.meta.env?.DEV ? (import.meta.env.VITE_BRIDGES as string | undefined) : undefined;

export const SEED_BRIDGES: readonly string[] = override ? override.split(",") : LIVE;
