/**
 * The Receiver's Android app, when these screens run inside it. The other half
 * is `ShellApi.kt` in receiver-apk. In a browser or an installed PWA there is
 * no shell and everything here is undefined.
 *
 * The app adds only what a page in a WebView cannot do itself: it is already
 * "installed", and it shows notifications, which a WebView has no API for.
 */
export interface Shell {
  /** Shows a notification with this title. Never pass the text of an SMS. */
  notify(title: string): void;
  /** "granted", "denied", or "default" when the person has not been asked. */
  notifications(): string;
  /** Asks Android. The answer arrives as an `easyotp:change` event. */
  askNotifications(): void;
}

export const shell: Shell | undefined = (window as Window & { EasyOtpShell?: Shell }).EasyOtpShell;

export const SHELL_CHANGE = "easyotp:change";
