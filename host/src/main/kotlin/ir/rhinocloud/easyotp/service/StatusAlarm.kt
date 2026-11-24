package ir.rhinocloud.easyotp.service

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock

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
        schedule(context)
        ForwarderService.wake(context, ForwarderService.ACTION_STATUS)
    }

    companion object {
        /** What a report says about how often to expect one. */
        const val EVERY_SECONDS = 900

        private const val FIRE_EVERY_MILLIS = 12 * 60 * 1000L

        /** Sets the next alarm, replacing any already set. Safe to call repeatedly. */
        fun schedule(context: Context) {
            val alarms = context.getSystemService(AlarmManager::class.java) ?: return
            alarms.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + FIRE_EVERY_MILLIS,
                intent(context),
            )
        }

        /** Nobody is paired any more, so there is nobody to report to. */
        fun cancel(context: Context) {
            context.getSystemService(AlarmManager::class.java)?.cancel(intent(context))
        }

        private fun intent(context: Context): PendingIntent = PendingIntent.getBroadcast(
            context, 0, Intent(context, StatusAlarm::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
