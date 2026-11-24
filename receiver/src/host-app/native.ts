/**
 * What the Host's screens can ask of the phone. The other half is `HostApi.kt`
 * in the Host app, which says the same in Kotlin; a change to one is a change
 * to both.
 *
 * The screens hold no keys and make no requests. They draw what `state()`
 * returns, call a method when a button is pressed, and read the state again
 * when the phone says something changed.
 */

/** `send` and `calls` are the two optional powers (DECISIONS D31), asked for only when switched on. */
export type Permission = "sms" | "phone" | "notify" | "battery" | "send" | "calls" | "contacts";
/** What the phone can be asked to open. `autostart` is the maker's own app-killer screen. */
export type Askable = Permission | "settings" | "autostart";
/** Phone makers whose phones hide a second app-killer of their own. */
export type Brand = "xiaomi" | "huawei" | "oppo" | "vivo" | "samsung" | "asus";

export interface HostState {
  version: string;
  /** The version of the screens showing: built into the APK, or fetched later (D32). */
  screens?: number;
  /** Set when this phone's maker hides an app-killer of its own; see BrandSetup.kt. */
  brand: Brand | null;
  /** What Receivers see this phone called. */
  label: string;
  /** The owner has confirmed they may forward this phone's messages. */
  consent: boolean;
  /** Receivers are told of calls and may decline them. */
  calls: boolean;
  /** A sender's name from this phone's contacts is sent along. */
  contacts: boolean;
  perms: Record<Permission, boolean>;
  sims: Array<{ key: string; name: string }>;
  receivers: Array<{ id: string; label: string; pairedAt: number; sims: string[] | null; canSend: boolean }>;
  /** SMS captured and not yet handed to a bridge. */
  pending: number;
  test: { ok: boolean; at: number } | null;
  /** Set while the phone is ringing because a Receiver asked: who asked. */
  ring: { from: string } | null;
  pair: null | {
    stage: "waiting" | "picture" | "failed";
    code: string;
    /** The bytes the picture is drawn from, base64url. */
    sas: string | null;
    /** What the Receiver calls itself. */
    peer: string | null;
    reason: "unreachable" | "timeout" | null;
  };
}

export interface Native {
  state(): string;
  ask(what: Askable): void;
  setLabel(label: string): void;
  setConsent(agreed: boolean): void;
  pairStart(): void;
  /** Returns the new Receiver's id, or an empty string. */
  pairAnswer(same: boolean): string;
  pairCancel(): void;
  /** `sims` is a JSON array of SIM keys, or the text `null` for every SIM. */
  setReceiverSims(id: string, sims: string): void;
  /** Whether this Receiver may make the phone send an SMS. */
  setReceiverCanSend(id: string, allowed: boolean): void;
  setCalls(on: boolean): void;
  setContacts(on: boolean): void;
  removeReceiver(id: string): void;
  sendTest(): void;
  stopRing(): void;
  exit(): void;
  /** The screens drew. A Host that tried new screens keeps them only after this. */
  ready?(): void;
}

declare global {
  interface Window {
    EasyOtpNative?: Native;
  }
}

/**
 * The version of this interface. Screens fetched without a new APK (D32) say
 * which version they need, and a Host with an older one keeps the screens it
 * was built with. Raise it when a method is added that the screens rely on.
 */
export const CORE = 1;

/** The phone tells the screens to read the state again with this event. */
export const CHANGE = "easyotp:change";
/** The phone's Back button. */
export const BACK = "easyotp:back";

/**
 * On a phone this is the app. In a development browser it is a stand-in, so
 * the screens can be worked on and tested without a phone. A released build
 * outside the app has nothing to talk to and says so.
 */
export async function loadNative(): Promise<Native | null> {
  if (window.EasyOtpNative) return window.EasyOtpNative;
  if (import.meta.env.DEV) return (await import("./mock")).mockNative();
  return null;
}
