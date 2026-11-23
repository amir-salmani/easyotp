import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import type { Strings } from "./i18n";
import { Button, Card, Screen } from "./ui";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}

/** True once the app runs from the home screen, on any platform. */
export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Shown in a browser tab, and nothing else is. A page cannot install itself,
 * so this is as far as "must be installed" can be taken: the app does not
 * start until it is opened from the home screen.
 */
export function Install({ t, header }: { t: Strings; header: React.ReactNode }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const steps = (title: string, items: string[]) => (
    <Card>
      <h2 className="mb-2 text-lg font-semibold">{title}</h2>
      <ol className="list-decimal space-y-1 ps-6">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
    </Card>
  );

  return (
    <Screen>
      {header}
      <img src="/icons/icon-192.png" alt="" width={96} height={96} className="rounded-xl" />
      <h1 className="text-2xl font-bold">{t.installTitle}</h1>
      <p>{t.installBody}</p>
      {prompt && (
        <Button onClick={() => void prompt.prompt()}>
          <Download aria-hidden size={22} strokeWidth={2} />
          {t.installButton}
        </Button>
      )}
      {steps(t.installIosTitle, [t.installIos1, t.installIos2, t.installIos3])}
      {steps(t.installOtherTitle, [t.installOther1, t.installOther2, t.installOther3])}
    </Screen>
  );
}
