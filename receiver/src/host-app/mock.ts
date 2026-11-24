/**
 * The phone, played by a browser tab. Development only: `native.ts` loads this
 * when there is no app around the page, and a released build never includes it.
 *
 * Pairing here is real. It uses the Host's side of the protocol as the tests
 * and the stand-in Host do, so these screens can be paired with a Receiver in
 * another tab against bridges on this machine.
 */
import { SEED_BRIDGES } from "../bridges";
import { b64url } from "../open";
import { newCode, pairAsHost, PairingError } from "../pairing";
import { CHANGE, type HostState, type Native, type Permission } from "./native";

export function mockNative(): Native {
  const query = new URLSearchParams(location.search);
  // ?ready skips the setup, for working on the screens after it.
  const ready = query.has("ready");
  const state: HostState = {
    version: "dev",
    label: "Galaxy A14",
    consent: ready,
    calls: false,
    perms: { sms: ready, phone: ready, notify: ready, battery: ready, send: false, calls: false },
    sims: [
      { key: "sub:1", name: "IR-MCI · SIM 1" },
      { key: "sub:2", name: "Irancell · SIM 2" },
    ],
    // ?paired starts with someone connected, for working on what a connected Receiver may do.
    receivers: query.has("paired") ? [{ id: "r1", label: "iPhone امیر", pairedAt: Date.now() - 86_400_000, sims: null, canSend: false }] : [],
    pending: 0,
    test: null,
    // ?ring plays a phone that is ringing.
    ring: query.has("ring") ? { from: "iPhone امیر" } : null,
    pair: null,
  };
  const changed = () => window.dispatchEvent(new Event(CHANGE));
  let attempt = 0;

  return {
    state: () => JSON.stringify(state),
    ask(what) {
      // ?deny plays a phone that refuses the SMS permission, as Android does
      // for an app installed from outside the store.
      if (what === "settings" || (what === "sms" && query.has("deny"))) return changed();
      state.perms[what as Permission] = true;
      changed();
    },
    setLabel(label) {
      state.label = label;
      changed();
    },
    setConsent(agreed) {
      state.consent = agreed;
      changed();
    },
    pairStart() {
      const mine = ++attempt;
      const code = newCode();
      state.pair = { stage: "waiting", code, sas: null, peer: null, reason: null };
      changed();
      pairAsHost({ bridges: SEED_BRIDGES, code, label: state.label, timeoutMs: 10 * 60 * 1000 }).then(
        (found) => {
          if (mine !== attempt) return;
          // Two bytes are all a picture is drawn from; see pictureFrom.
          const sas = b64url(new Uint8Array([found.picture.colour, found.picture.thing]));
          state.pair = { stage: "picture", code, sas, peer: found.peerLabel, reason: null };
          changed();
        },
        (e) => {
          if (mine !== attempt) return;
          const reason = e instanceof PairingError && e.reason === "timeout" ? "timeout" : "unreachable";
          state.pair = { stage: "failed", code, sas: null, peer: null, reason };
          changed();
        },
      );
    },
    pairAnswer(same) {
      const pair = state.pair;
      state.pair = null;
      attempt++;
      let id = "";
      if (same && pair?.stage === "picture") {
        id = `r${Date.now()}`;
        state.receivers.push({ id, label: pair.peer ?? "", pairedAt: Date.now(), sims: null, canSend: false });
      }
      changed();
      return id;
    },
    pairCancel() {
      attempt++;
      state.pair = null;
      changed();
    },
    setReceiverSims(id, sims) {
      const receiver = state.receivers.find((r) => r.id === id);
      if (receiver) receiver.sims = JSON.parse(sims) as string[] | null;
      changed();
    },
    setReceiverCanSend(id, allowed) {
      const receiver = state.receivers.find((r) => r.id === id);
      if (receiver) receiver.canSend = allowed;
      changed();
    },
    setCalls(on) {
      state.calls = on;
      changed();
    },
    removeReceiver(id) {
      state.receivers = state.receivers.filter((r) => r.id !== id);
      changed();
    },
    sendTest() {
      setTimeout(() => {
        state.test = { ok: true, at: Date.now() };
        changed();
      }, 600);
    },
    stopRing() {
      state.ring = null;
      changed();
    },
    exit() {},
  };
}
