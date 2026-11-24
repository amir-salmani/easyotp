package ir.rhinocloud.easyotp.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.provider.Settings

/**
 * Wakes the phone to report on itself (DECISIONS D26).
 *
 * An alarm, not a timer inside the service: a phone left alone goes into deep
 * sleep, where a thread's timer does not run at all. Android lets an alarm of
 * this kind through about once every nine minutes even then.
 *
 * It fires more often than [EVERY_SECONDS], the interval the report states.
 * The alarm is inexact and Android may deliver it late, and a Receiver calls
 * the phone silent after two and a half stated intervals. The slack keeps a
 * late alarm from reading as a dead phone.
 */
class StatusAlarm : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        schedule(context, force = true)
        ForwarderService.wake(context, ForwarderService.ACTION_STATUS)
    }

    companion object {
        /** What a report says about how often to expect one. */
        const val EVERY_SECONDS = 900

        private const val FIRE_EVERY_MILLIS = 12 * 60 * 1000L

        /**
         * Makes sure an alarm is set. Safe to call on every wake.
         *
         * An alarm already set is left alone: the service wakes for every SMS
         * and call, and pushing the next report away each time would make a
         * busy phone look dead to its Receivers. A reboot clears alarms, so
         * one set before the last boot does not count.
         */
        fun schedule(context: Context, force: Boolean = false) {
            val alarms = context.getSystemService(AlarmManager::class.java) ?: return
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val now = SystemClock.elapsedRealtime()
            val boot = runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT) }.getOrDefault(-1)
            val due = prefs.getLong(KEY_DUE, 0L)
            val pending = prefs.getInt(KEY_BOOT, -2) == boot && due > now && due <= now + FIRE_EVERY_MILLIS
            if (pending && !force) return
            val next = now + FIRE_EVERY_MILLIS
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, next, intent(context))
            prefs.edit().putLong(KEY_DUE, next).putInt(KEY_BOOT, boot).apply()
        }

        /** Nobody is paired any more, so there is nobody to report to. */
        fun cancel(context: Context) {
            context.getSystemService(AlarmManager::class.java)?.cancel(intent(context))
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        }

        private const val PREFS = "easyotp.alarm"
        private const val KEY_DUE = "due"
        private const val KEY_BOOT = "boot"

        private fun intent(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, 0, Intent(context, StatusAlarm::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
