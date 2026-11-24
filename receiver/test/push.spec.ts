/** Leaving this device's push address at the bridges, and taking it back. */
import { describe, expect, it } from "vitest";
import { leaveAddress, takeBackAddress, VAPID_PUBLIC_KEY } from "../src/push";
import wrangler from "../../bridge/wrangler.jsonc?raw";

const box = { boxId: "b".repeat(43), boxKey: "k".repeat(43) };

function recorder(status: (url: string) => number | "down") {
  const calls: Array<{ url: string; method: string; auth: string | null; body: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body: (init?.body as string) ?? null });
    const s = status(url);
    if (s === "down") throw new Error("unreachable");
    return new Response("{}", { status: s });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("this device's push address", () => {
  it("is left at every bridge, under the box key, and a bridge that cannot push is no failure", async () => {
    // Bridge 1 never calls out and answers 404; bridge 2 takes it.
    const { calls, fetchImpl } = recorder((url) => (url.startsWith("https://one") ? 404 : 200));
    const taken = await leaveAddress(["https://one", "https://two"], box, "https://web.push.apple.com/abc", fetchImpl);
    expect(taken).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([`https://one/v2/box/${box.boxId}/push`, `https://two/v2/box/${box.boxId}/push`]);
    expect(calls.every((c) => c.method === "POST" && c.auth === `Bearer ${box.boxKey}`)).toBe(true);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ endpoint: "https://web.push.apple.com/abc" });
  });

  it("survives a bridge that is down", async () => {
    const { fetchImpl } = recorder((url) => (url.startsWith("https://one") ? "down" : 200));
    expect(await leaveAddress(["https://one", "https://two"], box, "https://web.push.apple.com/abc", fetchImpl)).toBe(1);
    await expect(takeBackAddress(["https://one", "https://two"], box, fetchImpl)).resolves.toBeUndefined();
  });

  it("is taken back with the box key", async () => {
    const { calls, fetchImpl } = recorder(() => 200);
    await takeBackAddress(["https://two"], box, fetchImpl);
    expect(calls).toEqual([{ url: `https://two/v2/box/${box.boxId}/push`, method: "DELETE", auth: `Bearer ${box.boxKey}`, body: null }]);
  });
});

describe("the push signing key", () => {
  it("is the one the bridge signs with", () => {
    // The browser ties an address to this key. If the two files drift, every
    // push is refused by the push service and nothing says why.
    expect(wrangler).toContain(`"VAPID_PUBLIC_KEY": "${VAPID_PUBLIC_KEY}"`);
  });
});
