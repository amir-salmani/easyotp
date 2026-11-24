/**
 * Files the Host trusts from the bridges: the bridge list and its own screens
 * (DECISIONS D32). Each is signed with a key that lives only on the
 * maintainer's machine; the public half is here and in the Host's Dist.kt.
 *
 * An envelope:
 *
 *   { v: 1, kind, version, core, payload, sig }
 *
 *   payload  base64url of the bytes: a JSON bridge list, or a gzipped bundle
 *   sig      Ed25519 over "easyotp/dist/v1\n<kind>\n<version>\n<core>\n<payload>"
 *
 * The signature covers the kind and the version, so a bridge can neither pass
 * one file off as another nor serve an old file as new.
 */
export const DIST_PUBLIC_KEY = "NOUSVubm1JMqUKtlPPc8UyjnPawVxLc_mVOEqPwejpg";

export type DistKind = "bridges" | "host-ui";

export interface DistEnvelope {
  v: 1;
  kind: DistKind;
  /** Seconds since 1970 when it was signed. A Host takes only a newer one. */
  version: number;
  /** For screens: the version of the Host's native interface they need. 0 for a list. */
  core: number;
  payload: string;
  sig: string;
}

export const signedText = (e: Omit<DistEnvelope, "sig" | "v">) => `easyotp/dist/v1\n${e.kind}\n${e.version}\n${e.core}\n${e.payload}`;
