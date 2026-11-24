package ir.rhinocloud.easyotp.capture

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.telephony.TelephonyManager
import android.util.Log
import ir.rhinocloud.easyotp.data.CapturedMessage
import ir.rhinocloud.easyotp.data.Outbox
import ir.rhinocloud.easyotp.data.Settings
import ir.rhinocloud.easyotp.service.ForwarderService
import ir.rhinocloud.easyotp.service.SendLedger
import java.util.concurrent.Executors

/** A call that is ringing now, as much as this phone was told about it. */
data class Ringing(val number: String, val simKey: String, val at: Long) {
    /** Someone picked up, here or from a Receiver. A call that was dealt with is not a missed one. */
    @Volatile
    var handled = false
}

/**
 * Tells Receivers that the phone is ringing, and afterwards that nobody
 * answered (DECISIONS D31). Off unless the owner turned calls on.
 *
 * It never answers a call and hears nothing of one. It learns that the phone
 * rings and from which number, which is what the phone's own screen shows.
 * Like [SmsReceiver] it is declared in the manifest, so it runs with the app
 * closed, and it stores before it does anything else.
 */
class CallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        // Android sends each change twice to an app that may read the call
        // log: once without the number and once with it.
        @Suppress("DEPRECATION")
        val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
        val subscription = intent.getIntExtra(SUBSCRIPTION_EXTRA, intent.getIntExtra(SUBSCRIPTION_EXTRA_OLD, SimRegistry.INVALID_SUBSCRIPTION_ID))
        val app = context.applicationContext

        val pending = goAsync()
        WORKER.execute {
            try {
                when (state) {
                    TelephonyManager.EXTRA_STATE_RINGING -> if (!number.isNullOrBlank() && current == null) ring(app, number, subscription)
                    TelephonyManager.EXTRA_STATE_OFFHOOK -> current?.handled = true
                    TelephonyManager.EXTRA_STATE_IDLE -> {
                        val ended = current
                        current = null
                        if (ended != null && !ended.handled) store(app, ended, CapturedMessage.KIND_MISSED)
                    }
                }
            } catch (e: Exception) {
                // Never the number (THREAT-MODEL rule 1).
                Log.e(TAG, "call: ${e.javaClass.simpleName}")
            } finally {
                pending.finish()
            }
        }
    }

    private fun ring(context: Context, number: String, subscription: Int) {
        val settings = Settings(context)
        if (!settings.calls) return
        if (context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return
        val registry = SimRegistry(context)
        // The SIM the call came in on. Android does not promise to say; with
        // one SIM in the phone there is nothing to guess, and with two and no
        // answer the call is left out rather than put under the wrong line.
        val sim = registry.resolve(subscription) ?: registry.activeSims().singleOrNull()
        if (sim == null) {
            Log.w(TAG, "call on an unknown SIM left out")
            return
        }
        val call = Ringing(number, sim.iccid, System.currentTimeMillis())
        current = call
        // Whoever called may be answered by SMS: that is what declining with a message is.
        runCatching { SendLedger(context, settings.installSalt()).heardFrom(sim.iccid, number, call.at) }
        store(context, call, CapturedMessage.KIND_CALL)
    }

    private fun store(context: Context, call: Ringing, kind: String) {
        val wanted = runCatching { Settings(context).receiversFor(call.simKey).isNotEmpty() }.getOrDefault(true)
        if (!wanted) return
        val stored = Outbox(context).enqueue(CapturedMessage(call.simKey, call.number, "", call.at, kind))
        Log.i(TAG, "call $kind new=$stored")
        if (stored) ForwarderService.wake(context)
    }

    companion object {
        private const val TAG = "EasyOTP"

        /** Where Android puts the SIM on the broadcast. Neither name is promised; both are tried. */
        private const val SUBSCRIPTION_EXTRA = "android.telephony.extra.SUBSCRIPTION_INDEX"
        private const val SUBSCRIPTION_EXTRA_OLD = "subscription"

        private val WORKER = Executors.newSingleThreadExecutor()

        /**
         * The call ringing now, or null. In memory only: if Android stops the
         * app mid-ring, the Receiver has already been told of the call and is
         * simply not told that it was missed.
         */
        @Volatile
        var current: Ringing? = null
            private set
    }
}
