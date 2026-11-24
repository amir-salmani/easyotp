/**
 * A fetch for the command-line tools that does not trust a connection to stay
 * good. Seen on 2026-11-23 from one workstation: Node's reused connections to
 * the bridge on Cloudflare stalled in bursts, while new connections, curl and
 * a phone were all fine. The cause was not established. Every request the
 * tools make is safe to repeat (a deposit is recognised by its id, an
 * acknowledgement and a read change nothing twice), so a request that stalls
 * is simply made again.
 */
const TRIES = 4;

export const steadyFetch: typeof fetch = async (input, init) => {
  const post = (init?.method ?? "GET") !== "GET";
  // A read may legitimately wait out a bridge's hold; a write never should.
  const limit = post ? 8_000 : 70_000;
  let last: unknown;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    try {
      const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(limit)]) : AbortSignal.timeout(limit);
      return await fetch(input, { ...init, signal });
    } catch (e) {
      last = e;
      // Stopped on purpose by the caller: not something to try again.
      if (init?.signal?.aborted) throw e;
    }
  }
  throw last;
};
