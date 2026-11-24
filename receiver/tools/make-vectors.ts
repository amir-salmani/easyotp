/**
 * Writes test/pairing-vectors.json: one pairing and one command, worked through
 * by this code, with every value written down.
 *
 * The Host app's pairing is a second implementation, in Kotlin. Its tests
 * recompute this file, and so does test/vectors.spec.ts here, so neither side
 * can drift without a test failing. Run this only when the protocol changes on
 * purpose: `npm run make-vectors`, then commit the file.
 */
import { writeFileSync } from "node:fs";
import { boxIdFrom, randomKey, slotIdFrom } from "../src/ids";
import { b64url, newKeyPair, seal, sealBytes, type Command } from "../src/open";
import { cleanLabel, commitmentOf, offerId, sasOf } from "../src/pairing";
import { pictureFrom } from "../src/pictures";

const utf8 = (s: string) => new TextEncoder().encode(s);

const code = "04821357";
const hostNonce = randomKey(32);
const oneTime = await newKeyPair();
const receiver = await newKeyPair();
const receiverBoxKey = randomKey();
const receiverNonce = randomKey(16);
// Persian with a half-space, and an emoji placed so that cutting at forty
// characters would split it: the two things most likely to differ between a
// browser and a phone.
const rawLabel = "گوشیِ خانه‌ی مادربزرگ اتاق نشیمن طبقه‌ی📱 است";
const hostLabel = cleanLabel(rawLabel);
const receiverLabel = cleanLabel("iPhone — Amir 📲");

const body = { pk: receiver.publicKey, box: await boxIdFrom(receiverBoxKey), label: receiverLabel, n: receiverNonce };
const offer = await sealBytes(oneTime.publicKey, utf8(JSON.stringify(body)));

const sas = await sasOf({
  code, hostNonce, receiverNonce, pk: body.pk, box: body.box,
  oneTimeKey: oneTime.publicKey, hostLabel, receiverLabel,
});

const commandKeys = await newKeyPair();
const command: Command = { v: 2, k: "cmd", id: randomKey(24), at: 1_800_000_000_000, cmd: "buzz" };

const vectors = {
  note: "Made by receiver/tools/make-vectors.ts. Test keys, valid nowhere.",
  code,
  slotId: await slotIdFrom(code),
  hostNonce,
  commitment: await commitmentOf(hostNonce),
  oneTime,
  receiver: { ...receiver, boxKey: receiverBoxKey, boxId: body.box, label: receiverLabel, nonce: receiverNonce },
  hostLabel,
  rawLabel,
  offer,
  offerId: await offerId(offer),
  sas: b64url(sas),
  picture: pictureFrom(sas),
  command: { keys: commandKeys, id: command.id, cmd: command.cmd, at: command.at, ...(await seal(commandKeys.publicKey, command)) },
};

writeFileSync(new URL("../test/pairing-vectors.json", import.meta.url), JSON.stringify(vectors, null, 2) + "\n");
console.log("wrote test/pairing-vectors.json");
