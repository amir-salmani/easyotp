import { ChevronDown, ExternalLink, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PairedHost } from "./db";
import type { Lang, Strings } from "./i18n";
import { shell, SHELL_CHANGE } from "./shell";
import { Button } from "./ui";

const SOURCE = "https://github.com/amir-salmani/easyotp";

/** A yes-or-no question for something that cannot be undone. */
function Confirm(props: { title: string; body: string; yes: string; no: string; onYes: () => void; onNo: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={props.onNo}
      className="m-auto w-[min(92vw,24rem)] rounded-xl border border-border bg-card p-6 text-card-foreground backdrop:bg-foreground/40"
    >
      <h3 className="mb-2 text-xl font-bold">{props.title}</h3>
      <p className="mb-6">{props.body}</p>
      <div className="flex flex-col gap-3">
        <Button variant="danger" onClick={props.onYes}>
          {props.yes}
        </Button>
        <Button variant="secondary" onClick={props.onNo}>
          {props.no}
        </Button>
      </div>
    </dialog>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <h3 className="text-lg font-bold">{title}</h3>
      {children}
    </section>
  );
}

function HostRow(props: { host: PairedHost; count: number; t: Strings; lang: Lang; onRename: (name: string) => void; onRemove: () => void }) {
  const { host, t, lang } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(host.name);
  const [asking, setAsking] = useState(false);
  const since = new Date(host.pairedAt).toLocaleDateString(lang === "fa" ? "fa-IR" : "en-GB", { dateStyle: "medium" });

  return (
    <li className="rounded-lg border border-border bg-card p-4">
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            props.onRename(name.trim() || host.name);
            setEditing(false);
          }}
        >
          <label htmlFor={`name-${host.id}`} className="font-semibold">
            {t.hostName}
          </label>
          <input
            id={`name-${host.id}`}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            className="min-h-12 rounded-lg border border-input bg-background px-4 text-lg"
            autoFocus
          />
          <Button type="submit">{t.save}</Button>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p dir="auto" className="truncate text-lg font-semibold">
              {host.name}
            </p>
            <p className="text-muted-foreground">
              {t.hostMessages(props.count)} · {t.hostPaired(since)}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <button onClick={() => setEditing(true)} aria-label={`${t.rename}: ${host.name}`} className="inline-flex size-12 items-center justify-center rounded-lg">
              <Pencil aria-hidden size={20} strokeWidth={2} />
            </button>
            <button onClick={() => setAsking(true)} aria-label={`${t.remove}: ${host.name}`} className="inline-flex size-12 items-center justify-center rounded-lg text-destructive">
              <Trash2 aria-hidden size={20} strokeWidth={2} />
            </button>
          </div>
        </div>
      )}
      {asking && (
        <Confirm
          title={t.removeTitle(host.name)}
          body={t.removeBody}
          yes={t.removeConfirm}
          no={t.cancel}
          onYes={() => {
            setAsking(false);
            props.onRemove();
          }}
          onNo={() => setAsking(false)}
        />
      )}
    </li>
  );
}

/**
 * The side panel behind the gear: the Hosts this device listens to, a few
 * settings, and the help. A native dialog, so the browser keeps focus inside
 * it and Escape closes it.
 */
export function Panel(props: {
  t: Strings;
  lang: Lang;
  hosts: PairedHost[];
  counts: Record<string, number>;
  /** Whether a closed app will be woken: true, false, or null when that was not tried. */
  wakes: boolean | null;
  /** The answer to "may this app notify" just changed, or the person asks to try again. */
  onNotifyChanged: () => void;
  spamAuto: boolean;
  onSpamAuto: (auto: boolean) => void;
  onClose: () => void;
  onLang: (lang: Lang) => void;
  onRename: (host: PairedHost, name: string) => void;
  onRemove: (host: PairedHost) => void;
  onPairAnother: () => void;
  onDeleteMessages: () => void;
}) {
  const { t, lang } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const [askingDelete, setAskingDelete] = useState(false);
  type Permission = "granted" | "denied" | "default" | "unsupported";
  const permission = (): Permission => (shell ? (shell.notifications() as Permission) : typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  const [notify, setNotify] = useState(permission);
  // Inside the Android app the answer to "may I notify" comes back as an event.
  useEffect(() => {
    const refresh = () => setNotify(permission());
    window.addEventListener(SHELL_CHANGE, refresh);
    return () => window.removeEventListener(SHELL_CHANGE, refresh);
  }, []);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const notifyText = { granted: t.notifyGranted, denied: t.notifyDenied, unsupported: t.notifyUnsupported, default: "" }[notify];

  return (
    <dialog
      ref={ref}
      onClose={props.onClose}
      // Fills the height and sits against the starting edge: the right in Persian, the left in English.
      className="m-0 me-auto h-dvh max-h-none w-[min(92vw,26rem)] max-w-none overflow-y-auto border-e border-border bg-background p-0 text-foreground backdrop:bg-foreground/40"
    >
      <div className="flex min-h-full flex-col gap-6 px-4 py-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">{t.menu}</h2>
          <button onClick={() => ref.current?.close()} aria-label={t.close} className="inline-flex size-12 items-center justify-center rounded-lg">
            <X aria-hidden size={24} strokeWidth={2} />
          </button>
        </div>

        <Section title={t.hostsTitle}>
          <ul className="flex flex-col gap-3">
            {props.hosts.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                count={props.counts[host.id] ?? 0}
                t={t}
                lang={lang}
                onRename={(name) => props.onRename(host, name)}
                onRemove={() => props.onRemove(host)}
              />
            ))}
          </ul>
          <Button variant="secondary" onClick={props.onPairAnother}>
            {t.pairAnother}
          </Button>
        </Section>

        <Section title={t.settingsTitle}>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-semibold">{t.languageLabel}</legend>
            <div className="grid grid-cols-2 gap-3">
              {(["fa", "en"] as const).map((code) => (
                <button
                  key={code}
                  lang={code}
                  aria-pressed={lang === code}
                  onClick={() => props.onLang(code)}
                  className={`min-h-12 rounded-lg border font-semibold ${lang === code ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}
                >
                  {code === "fa" ? t.languageFa : t.languageEn}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-2">
            <p className="font-semibold">{t.notifications}</p>
            {notify === "default" ? (
              <Button variant="secondary" onClick={async () => {
                  if (shell) return shell.askNotifications();
                  setNotify(await Notification.requestPermission());
                  props.onNotifyChanged();
                }}>
                {t.notifyOn}
              </Button>
            ) : (
              <p>{notifyText}</p>
            )}
            {/* Said plainly, because a notification that silently never comes looks like a lost code. */}
            {notify === "granted" && props.wakes === true && <p className="font-medium text-success">{t.wakesOn}</p>}
            {notify === "granted" && props.wakes === false && (
              <>
                <p className="font-medium text-destructive">{t.wakesOff}</p>
                <Button variant="secondary" onClick={props.onNotifyChanged}>
                  {t.retry}
                </Button>
              </>
            )}
            <p className="text-muted-foreground">{t.notifyHint}</p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-semibold">{t.spamTitle}</p>
            <label className="flex min-h-14 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 font-medium">
              <input type="checkbox" className="size-6 shrink-0" checked={props.spamAuto} onChange={(e) => props.onSpamAuto(e.target.checked)} />
              {t.spamAuto}
            </label>
            <p className="text-muted-foreground">{t.spamAutoHint}</p>
          </div>
          <Button variant="danger" onClick={() => setAskingDelete(true)}>
            {t.deleteMessages}
          </Button>
        </Section>

        <Section title={t.helpTitle}>
          <div className="flex flex-col gap-2">
            {t.help.map(([question, answer]) => (
              <details key={question} className="group rounded-lg border border-border bg-card">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 p-4 font-semibold">
                  {question}
                  <ChevronDown aria-hidden size={20} strokeWidth={2} className="shrink-0 transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <p className="px-4 pb-4">{answer}</p>
              </details>
            ))}
          </div>
        </Section>

        <Section title={t.aboutTitle}>
          <p>{t.aboutBody}</p>
          <a href={SOURCE} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center gap-2 font-semibold underline">
            {t.aboutSource}
            <ExternalLink aria-hidden size={18} strokeWidth={2} />
          </a>
          <p className="text-muted-foreground">
            {t.version}{" "}
            <span dir="ltr" className="font-mono">
              {__APP_VERSION__}
            </span>
          </p>
        </Section>
      </div>

      {askingDelete && (
        <Confirm
          title={t.deleteMessagesTitle}
          body={t.deleteMessagesBody}
          yes={t.deleteConfirm}
          no={t.cancel}
          onYes={() => {
            setAskingDelete(false);
            props.onDeleteMessages();
          }}
          onNo={() => setAskingDelete(false)}
        />
      )}
    </dialog>
  );
}
