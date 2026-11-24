package ir.rhinocloud.easyotp.service

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.SmsManager
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Sends one SMS from one SIM and says whether the network took it.
 *
 * Only [ForwarderService] calls this, and only after [SendPolicy] has agreed
 * (DECISIONS D31). Nothing here decides whether a message may be sent.
 */
object SmsSender {

    private val main = Handler(Looper.getMainLooper())
    private val serial = AtomicInteger()

    /** @param onResult called once, on the main thread: true if every part was handed to the network. */
    fun send(context: Context, subscriptionId: Int, to: String, text: String, onResult: (Boolean) -> Unit) {
        val app = context.applicationContext
        val done = AtomicBoolean(false)
        val action = "ir.rhinocloud.easyotp.SMS_SENT.${serial.incrementAndGet()}"
        var waiting = 0
        var receiver: BroadcastReceiver? = null

        fun finish(ok: Boolean) {
            if (!done.compareAndSet(false, true)) return
            receiver?.let { runCatching { app.unregisterReceiver(it) } }
            main.post { onResult(ok) }
        }

        try {
            val manager = if (Build.VERSION.SDK_INT >= 31) {
                app.getSystemService(SmsManager::class.java).createForSubscriptionId(subscriptionId)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
            }
            val parts = manager.divideMessage(text)
            waiting = parts.size
            receiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    // One answer per part. Any part the network refused fails the whole message.
                    if (resultCode != Activity.RESULT_OK) finish(false) else if (--waiting == 0) finish(true)
                }
            }
            if (Build.VERSION.SDK_INT >= 33) {
                app.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag") // The flag does not exist before API 33.
                app.registerReceiver(receiver, IntentFilter(action))
            }
            val sent = ArrayList<PendingIntent>(parts.size)
            repeat(parts.size) { i ->
                sent += PendingIntent.getBroadcast(
                    app, i, Intent(action).setPackage(app.packageName),
                    PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE,
                )
            }
            manager.sendMultipartTextMessage(to, null, parts, sent, null)
            // A network that never answers is not a success.
            main.postDelayed({ finish(false) }, TIMEOUT_MILLIS)
        } catch (e: Exception) {
            Log.w(TAG, "send: ${e.javaClass.simpleName}")
            finish(false)
        }
    }

    private const val TAG = "EasyOTP"
    private const val TIMEOUT_MILLIS = 60_000L
}
