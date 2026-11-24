/**
 * Asking a Host to do something: ring, or report on itself now.
 *
 * A command is sealed to a key the Host made for this one Receiver and gave it
 * at pairing, and left in a box only that Host collects from. The Host answers
 * with a report that names the command, which is how the person who pressed
 * the button knows the phone at home really rang.
 */
import { randomKey } from "./ids";
import { seal, type Command } from "./open";
import type { Fetch, HostChannel } from "./pairing";

/** Leaves a command at every bridge. Resolves with its id once one bridge has it. */
export async function sendCommand(
  bridges: readonly string[],
  host: HostChannel,
  cmd: Command["cmd"],
  fetchImpl: Fetch = (input, init) => fetch(input, init),
  /** What an `sms` or a `decline` carries. */
  extra: Pick<Command, "to" | "text" | "sim"> = {},
): Promise<string> {
  const command: Command = { v: 2, k: "cmd", id: randomKey(24), at: Date.now(), cmd, ...extra };
  const { enc, ct } = await seal(host.publicKey, command);
  const body = JSON.stringify({ v: 2, id: command.id, enc, ct });
  const post = async (bridge: string) => {
    const res = await fetchImpl(`${bridge}/v2/box/${host.boxId}`, { method: "POST", body, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error();
  };
  await Promise.any(bridges.map(post));
  return command.id;
}
