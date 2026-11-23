import { BatteryCharging, BatteryLow, BatteryMedium, Bell, Check, CircleAlert, RefreshCw, Signal, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { SEED_BRIDGES } from "../bridges";
import { sendCommand } from "../commands";
import type { Command } from "../open";
import type { PairedHost } from "./db";
import { when, type Lang, type Strings } from "./i18n";
import { Card } from "./ui";

/** A Host is taken for alive while its last report is younger than this many of its own intervals. */
const MISSED_REPORTS = 2.5;
/** How long to wait for a phone to say it rang. */
const ANSWER_MS = 30_000;

type Asked = { cmd: Command["cmd"]; id: string | null; at: number; result?: "done" | "silent" };

/**
 * One Host: whether it is alive, when it was last heard, its battery, its
 * network, and two things to ask of it. This is what tells the person abroad
 * that the phone at home has died before the day they need a code.
 */
function HostMonitor({ host, t, lang, now, showName }: { host: PairedHost; t: Strings; lang: Lang; now: number; showName: boolean }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  const status = host.status;

  // The Host answers a command with a report that names it.
  useEffect(() => {
    if (asked?.id && !asked.result && status?.ack === asked.id) setAsked({ ...asked, result: "done" });
  }, [asked, status?.ack]);

  useEffect(() => {
    if (!asked || asked.result) return;
    const left = asked.at + ANSWER_MS - Date.now();
    const timer = setTimeout(() => setAsked((a) => (a && !a.result ? { ...a, result: "silent" } : a)), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [asked]);

  const ask = async (cmd: Command["cmd"]) => {
    if (!host.remote) return;
    const started: Asked = { cmd, id: null, at: Date.now() };
    setAsked(started);
    try {
      const id = await sendCommand(SEED_BRIDGES, host.remote, cmd);
      setAsked((a) => (a === started ? { ...started, id } : a));
    } catch {
      setAsked((a) => (a === started ? { ...started, result: "silent" } : a));
    }
  };

  const alive = status ? now - status.at < status.every * 1000 * MISSED_REPORTS : false;
  const low = status?.battery != null && status.battery < 20 && status.charging === false;
  const waiting = asked !== null && !asked.result;
  const Battery = status?.charging ? BatteryCharging : low ? BatteryLow : BatteryMedium;
  const Net = status?.net === "wifi" ? Wifi : status?.net === "cell" ? Signal : WifiOff;

  return (
    <Card className="flex flex-col gap-3">
      {showName && (
        <p dir="auto" className="text-lg font-semibold">
          {host.name}
        </p>
      )}

      {!status ? (
        <p className="text-muted-foreground">{host.remote ? t.neverReported : t.noReports}</p>
      ) : (
        <>
          {/* Said in words and marked with an icon: colour alone tells a colour-blind reader nothing. */}
          <p role="status" className={`flex items-center gap-2 font-semibold ${alive ? "text-success" : "text-destructive"}`}>
            {alive ? <Check aria-hidden size={20} strokeWidth={2} /> : <CircleAlert aria-hidden size={20} strokeWidth={2} />}
            {(alive ? t.alive : t.silent)(when(status.at, now, lang))}
          </p>
          <ul className="flex flex-wrap gap-x-5 gap-y-1">
            {status.battery != null && (
              <li className={`flex items-center gap-2 ${low ? "font-semibold text-destructive" : ""}`}>
                <Battery aria-hidden size={20} strokeWidth={2} />
                {t.battery(Math.round(status.battery))}
                {status.charging != null && ` · ${status.charging ? t.charging : t.notCharging}`}
              </li>
            )}
            {status.net && (
              <li className={`flex items-center gap-2 ${status.net === "none" ? "font-semibold text-destructive" : ""}`}>
                <Net aria-hidden size={20} strokeWidth={2} />
                {{ wifi: t.netWifi, cell: t.netCell, none: t.netNone }[status.net]}
              </li>
            )}
            {status.pending > 0 && <li>{t.pendingSms(status.pending)}</li>}
          </ul>
          {low && <p className="font-medium text-destructive">{t.batteryLow}</p>}
        </>
      )}

      {host.remote && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => void ask("buzz")}
              disabled={waiting}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-40"
            >
              <Bell aria-hidden size={20} strokeWidth={2} />
              {t.buzz}
            </button>
            <button
              onClick={() => void ask("ping")}
              disabled={waiting}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-secondary px-4 font-semibold text-secondary-foreground disabled:opacity-40"
            >
              <RefreshCw aria-hidden size={20} strokeWidth={2} />
              {t.refresh}
            </button>
          </div>
          {/* Empty until something is asked, so several Hosts do not push the messages off the screen. */}
          <p aria-live="polite" className={asked?.result === "silent" ? "font-medium text-destructive" : "text-muted-foreground"}>
            {!asked
              ? ""
              : waiting
                ? t.asking
                : asked.result === "silent"
                  ? t.noAnswer
                  : asked.cmd === "buzz"
                    ? t.buzzed
                    : t.refreshed}
          </p>
        </>
      )}
    </Card>
  );
}

export function Monitor({ hosts, t, lang, now }: { hosts: PairedHost[]; t: Strings; lang: Lang; now: number }) {
  return (
    <section aria-label={t.monitorTitle} className="flex flex-col gap-3">
      {hosts.map((host) => (
        <HostMonitor key={host.id} host={host} t={t} lang={lang} now={now} showName={hosts.length > 1} />
      ))}
    </section>
  );
}
