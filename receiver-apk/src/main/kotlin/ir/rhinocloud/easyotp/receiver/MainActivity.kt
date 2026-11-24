package ir.rhinocloud.easyotp.receiver

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import ir.rhinocloud.easyotp.shell.WebShell

/**
 * The Receiver's one window. The screens inside it are the same web build as
 * the PWA, bundled in the APK (DECISIONS D19): pairing, keys, collecting and
 * opening messages all happen there, exactly as in a browser.
 *
 * This adds what a page in a WebView cannot do: show a notification. It runs
 * nothing in the background. Messages are collected while the app is open or
 * recently used, as with the PWA; waking a closed app is not built yet.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        val shell = WebShell(this, assetRoot = "app", network = true)
        setContentView(shell.frame(web))
        web.addJavascriptInterface(ShellApi(), "EasyOtpShell")
        shell.attach(web)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        asked = true
        web.post { web.evaluateJavascript("window.dispatchEvent(new Event('easyotp:change'))", null) }
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Whether Android has already put the question once. After a refusal it will not ask again. */
    private var asked = false

    /** What the screens can ask of the app. Its twin is receiver/src/app/shell.ts. */
    private inner class ShellApi {

        @JavascriptInterface
        fun notifications(): String = when {
            Build.VERSION.SDK_INT < 33 -> "granted"
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED -> "granted"
            asked -> "denied"
            else -> "default"
        }

        @JavascriptInterface
        fun askNotifications() = runOnUiThread {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        /** The title only. The screens never pass the text of an SMS, which would show on a locked screen. */
        @JavascriptInterface
        fun notify(title: String) {
            val manager = getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, getString(R.string.messages_channel), NotificationManager.IMPORTANCE_HIGH),
                )
            }
            val open = PendingIntent.getActivity(
                this@MainActivity, 0, Intent(this@MainActivity, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            runCatching {
                manager.notify(
                    1,
                    Notification.Builder(this@MainActivity, CHANNEL_ID)
                        .setContentTitle(title.take(MAX_TITLE))
                        .setSmallIcon(android.R.drawable.stat_notify_chat)
                        .setContentIntent(open)
                        .setAutoCancel(true)
                        .build(),
                )
            }
        }
    }

    private companion object {
        const val CHANNEL_ID = "easyotp.messages"
        const val MAX_TITLE = 120
    }
}
