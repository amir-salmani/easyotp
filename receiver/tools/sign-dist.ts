/**
 * Signs what the Host trusts from the bridges (DECISIONS D32), on this machine
 * only. The key is read from the environment and never written anywhere:
 *
 *   sops exec-env ~/codebase/amir-salmani/secrets/machine.enc.yaml \
 *     'npm run sign-dist -- bridges host-ui'
 *
 *   bridges   signs bridge/dist-files/bridges.list.json
 *   host-ui   signs the Host's screens; run `npm run build:host` first
 *
 * The signed files land in bridge/dist-files/. Commit them; they reach phones
 * when the bridges are next deployed.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { DIST_PUBLIC_KEY, signedText, type DistEnvelope, type DistKind } from "../src/dist";
import { CORE } from "../src/host-app/native";

const OUT = new URL("../../bridge/dist-files/", import.meta.url).pathname;
const UI = new URL("../../host/src/main/assets/ui/", import.meta.url).pathname;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

const secret = process.env.EASYOTP_DIST_PRIVATE_KEY;
if (!secret) throw new Error("EASYOTP_DIST_PRIVATE_KEY is not set; run this under sops exec-env");
const key = await crypto.subtle.importKey("pkcs8", Buffer.from(secret, "base64url"), { name: "Ed25519" }, false, ["sign"]);

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = b64(readFileSync(path));
    }
  };
  walk(dir);
  return out;
}

const version = Math.floor(Date.now() / 1000);
const index: Record<string, { version: number; core: number }> = {};
for (const kind of process.argv.slice(2) as DistKind[]) {
  let bytes: Uint8Array;
  let core = 0;
  if (kind === "bridges") {
    const list = JSON.parse(readFileSync(join(OUT, "bridges.list.json"), "utf8")) as { bridges: unknown };
    bytes = new TextEncoder().encode(JSON.stringify({ bridges: list.bridges }));
  } else if (kind === "host-ui") {
    const built = files(UI);
    if (!built["host.html"]) throw new Error("no screens to sign; run npm run build:host first");
    bytes = gzipSync(JSON.stringify({ files: built }), { level: 9 });
    core = CORE;
  } else {
    throw new Error(`unknown kind ${kind}`);
  }
  const payload = b64(bytes);
  const sig = b64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(signedText({ kind, version, core, payload })))));
  // Signed with the key the apps carry, or a mismatched key would be found only on a phone.
  const pub = await crypto.subtle.importKey("raw", Buffer.from(DIST_PUBLIC_KEY, "base64url"), { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("Ed25519", pub, Buffer.from(sig, "base64url"), new TextEncoder().encode(signedText({ kind, version, core, payload }))))) {
    throw new Error("the key in the environment is not the one the apps trust");
  }
  const envelope: DistEnvelope = { v: 1, kind, version, core, payload, sig };
  writeFileSync(join(OUT, `${kind}.json`), JSON.stringify(envelope) + "\n");
  index[kind] = { version, core };
  console.log(`signed ${kind}: version ${version}, ${Math.round(payload.length / 1024)} KB`);
}

// The index says what each bridge holds, so a Host fetches a file only when it is newer.
const indexPath = join(OUT, "index.json");
const old = (() => {
  try {
    return JSON.parse(readFileSync(indexPath, "utf8")) as typeof index;
  } catch {
    return {};
  }
})();
writeFileSync(indexPath, JSON.stringify({ ...old, ...index }, null, 2) + "\n");
