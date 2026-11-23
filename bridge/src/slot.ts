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

/** Every slot a process holds, for an entry point with no per-slot object of its own. */
export class Slots {
  private slots = new Map<string, Slot>();

  constructor(private maxSlots: number) {}

  private sweep(now: number): void {
    for (const [id, slot] of this.slots) if (slot.expired(now)) this.slots.delete(id);
  }

  private open(slotId: string, now: number, create: boolean): Slot | null {
    let slot = this.slots.get(slotId);
    if (slot?.expired(now)) {
      this.slots.delete(slotId);
      slot = undefined;
    }
    if (!slot && create) {
      if (this.slots.size >= this.maxSlots) this.sweep(now);
      if (this.slots.size >= this.maxSlots) return null;
      slot = new Slot(now);
      this.slots.set(slotId, slot);
    }
    return slot ?? null;
  }

  post(slotId: string, from: "host" | "receiver", data: string, now: number): number | "full" {
    const slot = this.open(slotId, now, true);
    return slot ? slot.post(from, data) : "full";
  }

  /** Reading creates the slot too: whoever arrives first waits for the other. */
  read(slotId: string, after: number, holdMs: number, now: number): Promise<SlotMessage[]> {
    const slot = this.open(slotId, now, true);
    return slot ? slot.read(after, holdMs) : Promise.resolve([]);
  }

  get count(): number {
    return this.slots.size;
  }
}
