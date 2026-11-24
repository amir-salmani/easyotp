/**
 * Keeping advertising out of the inbox.
 *
 * An Iranian SIM gets a steady stream of offers, and they bury the codes this
 * app exists to show. Sorting happens here, on the Receiver, and only changes
 * where a message is listed: nothing is deleted, the Host still forwards
 * everything, and a message put under spam can always be brought back.
 *
 * Two things decide, in this order:
 *
 *   1. What the person said about the sender. "Spam" hides everything that
 *      sender sends; "not spam" protects it from the guess below.
 *   2. A guess, if it is switched on: the message looks like an advertisement.
 *
 * The guess never touches a message that carries a code. A sale hidden by
 * mistake costs nothing; a bank code hidden by mistake is the one failure this
 * product cannot have.
 */
import type { Message } from "./open";

export type SenderRule = "spam" | "ok";

export interface SpamSettings {
  /** What the person decided, by sender. */
  rules: Record<string, SenderRule>;
  /** Whether messages that look like advertising are sorted without being asked. */
  auto: boolean;
}

export const DEFAULT_SPAM: SpamSettings = { rules: {}, auto: true };

/** A sender is a number or a name, and names arrive in whatever case the carrier likes. */
export const senderKey = (from: string) => from.trim().toLowerCase();

const DIGIT = "[0-9۰-۹٠-٩]";

/**
 * "لغو۱۱", "لغو 11", "لغو=11", "لغو: ۱۱": how to stop receiving. Iranian
 * carriers require it on bulk advertising, and nothing else carries it, so it
 * is the one marker trusted alone.
 */
const OPT_OUT = new RegExp(`لغو\\s*[=:：]?\\s*${DIGIT}{1,4}(?!${DIGIT})`);

const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.(ir|com|net|org|app|shop|co)\b/i;
/** Words of a sale. None of them is trusted without a link beside it. */
const OFFER = /تخفیف|جشنواره|فروش ویژه|قرعه.?کشی|جایزه|رایگان|هدیه|پیشنهاد ویژه|کد تخفیف|فرصت محدود|همین حالا بخر|\boff\b|%|٪/i;

/** Whether a message reads as advertising. Never true for one that carries a code. */
export function looksLikeAd(m: Pick<Message, "body" | "code">): boolean {
  if (m.code) return false;
  if (OPT_OUT.test(m.body)) return true;
  return LINK.test(m.body) && OFFER.test(m.body);
}

export type Sorted = "inbox" | "spam-sender" | "spam-guess";

/** Where a message is listed, and why, so the screen can say which it was. */
export function sort(m: Pick<Message, "from" | "body" | "code" | "kind">, settings: SpamSettings): Sorted {
  // What this device's owner sent is theirs, whoever it went to.
  if (m.kind === "sent") return "inbox";
  const rule = settings.rules[senderKey(m.from)];
  if (rule === "spam") return "spam-sender";
  if (rule === "ok") return "inbox";
  return settings.auto && looksLikeAd(m) ? "spam-guess" : "inbox";
}

export const isSpam = (m: Pick<Message, "from" | "body" | "code" | "kind">, settings: SpamSettings) => sort(m, settings) !== "inbox";

/**
 * What to send, to whoever sent an advertisement, to stop getting them: the
 * digits of its "لغو۱۱", in Latin digits as a carrier expects. Null if the
 * message names none.
 */
export function optOutCode(body: string): string | null {
  const found = new RegExp(`لغو\\s*[=:：]?\\s*(${DIGIT}{1,4})(?!${DIGIT})`).exec(body)?.[1];
  if (!found) return null;
  return found.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** The settings with one sender's rule set, or cleared with null. */
export function withRule(settings: SpamSettings, from: string, rule: SenderRule | null): SpamSettings {
  const rules = { ...settings.rules };
  if (rule) rules[senderKey(from)] = rule;
  else delete rules[senderKey(from)];
  return { ...settings, rules };
}
