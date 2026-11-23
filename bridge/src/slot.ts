/**
 * A pairing slot: the few messages a Host and a Receiver exchange while two
 * people are on the phone to each other (DECISIONS D18, D24).
 *
 * Pure, like `Box`. A slot is found by an id both sides derive from the code
 * one person reads to the other. It needs no key because nothing in it is
 * trusted: what makes a pairing safe is the picture both people compare
 * afterwards, which a bridge that altered these messages cannot make match.
 *
 * A slot lives ten minutes and holds a handful of small messages. It is never
 * written to disk: if it is lost, the two people start again.
 */
export interface SlotMessage {
  seq: number;
  from: "host" | "receiver";
  /** Opaque to the bridge. */
  data: string;
}

export const SLOT_LIMITS = {
  maxMessages: 8,
  maxDataBytes: 2048,
  lifetimeMs: 10 * 60 * 1000,
} as const;

type Waiter = (messages: SlotMessage[]) => void;

export class Slot {
  private messages: SlotMessage[] = [];
  private waiters: Array<{ after: number; wake: Waiter }> = [];

  constructor(readonly createdAt: number) {}

  expired(now: number): boolean {
    return now - this.createdAt >= SLOT_LIMITS.lifetimeMs;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /** Appends a message and returns its number, or "full" past the limit. */
  post(from: "host" | "receiver", data: string): number | "full" {
    if (this.messages.length >= SLOT_LIMITS.maxMessages) return "full";
    const message = { seq: this.messages.length + 1, from, data };
    this.messages.push(message);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.wake(this.after(w.after));
    return message.seq;
  }

  private after(seq: number): SlotMessage[] {
    return this.messages.filter((m) => m.seq > seq);
  }

  /** Messages numbered above `after`, at once if any, else after up to `holdMs`. */
  read(after: number, holdMs: number): Promise<SlotMessage[]> {
    const ready = this.after(after);
    if (ready.length || holdMs <= 0) return Promise.resolve(ready);
    return new Promise<SlotMessage[]>((resolve) => {
      const waiter = {
        after,
        wake: (messages: SlotMessage[]) => {
          clearTimeout(timer);
          resolve(messages);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve([]);
      }, holdMs);
      this.waiters.push(waiter);
    });
  }
}

/** What a read returns. `epoch` changes when a slot is replaced by a new one. */
export interface SlotView {
  /** When this slot began, or 0 if nobody has posted to it yet. */
  epoch: number;
  messages: SlotMessage[];
}

/**
 * How long a read waits on a slot nobody has posted to. Short, because such a
 * read costs the bridge something and proves nothing: anyone can ask about any
 * id. A Receiver that arrives before its Host simply asks again.
 */
export const EMPTY_SLOT_HOLD_MS = 3000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A read of a slot that does not exist: a short wait, and nothing kept. */
export async function readNothing(holdMs: number): Promise<SlotView> {
  await sleep(Math.min(holdMs, EMPTY_SLOT_HOLD_MS));
  return { epoch: 0, messages: [] };
}

/** Every slot a process holds, for an entry point with no per-slot object of its own. */
export class Slots {
  private slots = new Map<string, Slot>();

  constructor(private maxSlots: number) {}

  private sweep(now: number): void {
    for (const [id, slot] of this.slots) if (slot.expired(now)) this.slots.delete(id);
  }

  private live(slotId: string, now: number): Slot | undefined {
    const slot = this.slots.get(slotId);
    if (slot?.expired(now)) {
      this.slots.delete(slotId);
      return undefined;
    }
    return slot;
  }

  /** Only a post makes a slot. A read never does, or reads alone could fill the bridge. */
  post(slotId: string, from: "host" | "receiver", data: string, now: number): number | "full" {
    let slot = this.live(slotId, now);
    if (!slot) {
      if (this.slots.size >= this.maxSlots) this.sweep(now);
      if (this.slots.size >= this.maxSlots) return "full";
      slot = new Slot(now);
      this.slots.set(slotId, slot);
    }
    return slot.post(from, data);
  }

  async read(slotId: string, after: number, holdMs: number, now: number): Promise<SlotView> {
    const slot = this.live(slotId, now);
    if (!slot) return readNothing(holdMs);
    return { epoch: slot.createdAt, messages: await slot.read(after, holdMs) };
  }

  get count(): number {
    return this.slots.size;
  }
}
