/**
 * One Receiver's box: sealed messages waiting to be collected.
 *
 * Pure. No I/O and no clock of its own, so the rules that decide whether a
 * message survives can be tested without a runtime. The Cloudflare and Node
 * entry points each wrap this with their own storage.
 *
 * A message stays until the Receiver acknowledges it, or until it is older
 * than the retention limit. Collecting does not remove anything: a Receiver
 * that dies between reading and showing a message gets it again.
 */
export interface Sealed {
  /** Chosen by the Host. The Receiver uses it to show a message once. */
  id: string;
  /** HPKE encapsulated key, base64url. */
  enc: string;
  /** HPKE ciphertext, base64url. */
  ct: string;
  /** When this bridge received it, in milliseconds. Not part of the seal. */
  at: number;
  /**
   * Set on a message that replaces the last one of its kind, such as a Host's
   * report on itself. Only the newest message with a given tag is kept, so a
   * report every few minutes cannot crowd real messages out of the box.
   */
  tag?: string;
}

export const LIMITS = {
  /** A sealed SMS is under 2 KB. This is the ceiling for one deposit. */
  maxMessageBytes: 16 * 1024,
  /** Per box. Past either limit the oldest message is dropped. */
  maxMessages: 100,
  maxBoxBytes: 512 * 1024,
  /** A code this old is useless, and a bridge is not an archive. */
  retentionMs: 48 * 60 * 60 * 1000,
  /**
   * Deposits per box in any minute. A real Host sends a few SMS, a report
   * every twelve minutes, and a copy of each at every bridge. Thirty a minute
   * is far above that and far below a flood: whoever learns a box id can
   * deposit, and without a pace they could push every real message out of
   * the box by sheer count (THREAT-MODEL A5).
   */
  depositsPerMinute: 30,
} as const;

/**
 * Counts deposits per box over the last minute. Memory only: a bridge that
 * restarts forgives, which costs nothing, since a flood would have to start
 * again from zero. Bounded, so made-up box ids cannot fill memory.
 */
export class Pace {
  private seen = new Map<string, number[]>();

  constructor(
    private perMinute: number = LIMITS.depositsPerMinute,
    private maxBoxes = 10_000,
  ) {}

  /** Whether a deposit to this box is allowed now. An allowed one is counted. */
  allow(boxId: string, now: number): boolean {
    const recent = (this.seen.get(boxId) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.perMinute) {
      this.seen.set(boxId, recent);
      return false;
    }
    recent.push(now);
    this.seen.delete(boxId);
    this.seen.set(boxId, recent);
    // A Map keeps insertion order, so the first key is the box heard from least recently.
    while (this.seen.size > this.maxBoxes) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}

export const sizeOf = (m: Sealed) => m.id.length + m.enc.length + m.ct.length + (m.tag?.length ?? 0);

type Waiter = (messages: Sealed[]) => void;

export class Box {
  private messages: Sealed[];
  private waiters: Waiter[] = [];

  constructor(snapshot: Sealed[] = []) {
    this.messages = [...snapshot];
  }

  /** What to persist. A copy, so a caller cannot change the box through it. */
  snapshot(): Sealed[] {
    return [...this.messages];
  }

  get count(): number {
    return this.messages.length;
  }

  get bytes(): number {
    return this.messages.reduce((n, m) => n + sizeOf(m), 0);
  }

  /** How many collectors are waiting. An idle box has none. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Drops what has outlived the retention limit. Returns whether anything went. */
  expire(now: number): boolean {
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => now - m.at < LIMITS.retentionMs);
    return this.messages.length !== before;
  }

  /**
   * Stores a message, unless one with the same id is already waiting. The Host
   * sends every message through every bridge and retries on failure, so the
   * same deposit arriving twice is the normal case.
   */
  add(m: Sealed): "stored" | "duplicate" {
    this.expire(m.at);
    if (this.messages.some((x) => x.id === m.id)) return "duplicate";
    if (m.tag) this.messages = this.messages.filter((x) => x.tag !== m.tag);
    this.messages.push(m);
    while (this.messages.length > LIMITS.maxMessages || this.bytes > LIMITS.maxBoxBytes) {
      this.messages.shift();
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake(this.snapshot());
    return "stored";
  }

  /** Everything waiting, at once if there is anything, else after up to `holdMs`. */
  collect(now: number, holdMs: number): Promise<Sealed[]> {
    this.expire(now);
    if (this.messages.length || holdMs <= 0) return Promise.resolve(this.snapshot());
    return new Promise<Sealed[]>((resolve) => {
      const waiter: Waiter = (messages) => {
        clearTimeout(timer);
        resolve(messages);
      };
      const timer = setTimeout(() => {
        // Remove this waiter so a later add() does not wake a request that
        // has already been answered.
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve([]);
      }, holdMs);
      this.waiters.push(waiter);
    });
  }

  /** Removes acknowledged messages. Returns how many were actually there. */
  ack(ids: readonly string[]): number {
    const gone = new Set(ids);
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => !gone.has(m.id));
    return before - this.messages.length;
  }
}
