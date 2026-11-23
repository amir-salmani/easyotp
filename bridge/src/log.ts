/**
 * Structured logging that cannot leak a message.
 *
 * THREAT-MODEL rule 1: nothing a person wrote or received, and no key, reaches
 * a log. The way to hold that is to make it impossible to pass one, so this
 * module accepts a closed set of scalar fields. There is no `extra`, no rest
 * parameter and no object spread from a caller. Adding a field is an edit a
 * reviewer will see.
 */
export type Outcome = "ok" | "rejected" | "timeout" | "full";

export interface LogFields {
  route: "deposit" | "collect" | "ack" | "pair" | "store";
  outcome: Outcome;
  /** First characters of a box id. Never a box key. */
  box?: string;
  status?: number;
  /** How many messages the event concerned. */
  n?: number;
  /** Stable machine-readable cause. Never built from a request. */
  reason?: string;
}

export function log(f: LogFields): void {
  console.log(JSON.stringify({ t: Date.now(), ...f }));
}

/** A box id lets its holder deposit, so only a prefix is ever written down. */
export function boxTag(boxId: string): string {
  return boxId.slice(0, 8);
}
