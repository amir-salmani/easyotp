package ir.rhinocloud.easyotp.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import ir.rhinocloud.easyotp.R
import ir.rhinocloud.easyotp.capture.MessageClassifier
import ir.rhinocloud.easyotp.data.CapturedMessage
import ir.rhinocloud.easyotp.data.Outbox
import ir.rhinocloud.easyotp.data.PendingMessage
import ir.rhinocloud.easyotp.data.Settings
import ir.rhinocloud.easyotp.data.SimRoute
import ir.rhinocloud.easyotp.net.BridgeClient
import ir.rhinocloud.easyotp.net.BridgeHealth
import ir.rhinocloud.easyotp.net.DepositResult
import ir.rhinocloud.easyotp.net.Payload
import ir.rhinocloud.easyotp.net.ReceiverSealer
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Drains the outbox.
 *
 * A foreground service rather than plain WorkManager because the phone is
 * unattended in another country: the persistent notification is the only sign,
 * to whoever walks past it, that forwarding is alive.
 *
 * Declared `specialUse`, not `dataSync`. Android 15 caps `dataSync` foreground
 * services at six hours per twenty-four, so a forwarder using it dies daily and
 * silently -- see DECISIONS D7.
 */
class ForwarderService : Service() {

    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val draining = AtomicBoolean(false)

    /** Set when a wake arrives mid-drain, so the drain runs once more after it ends. */
    private val drainAgain = AtomicBoolean(false)

    /** The one pending retry. Replaced, never stacked. */
    @Volatile
    private var retry: ScheduledFuture<*>? = null

    private val outbox by lazy { Outbox(applicationContext) }
    private val settings by lazy { Settings(applicationContext) }

    private val client by lazy { BridgeClient(BridgeHealth(settings.bridges)) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // From API 34 the type must be passed explicitly when the manifest
        // declares one, or startForeground throws.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification(0),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification(0))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        drain()
        // Restart if killed, but without redelivering the intent: the work to do
        // is whatever is in the outbox, not whatever this particular intent said.
        return START_STICKY
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun drain() {
        // One drain at a time. Concurrent passes would claim the same rows and
        // deliver duplicates. The Receiver would hide them, but they should
        // not be created here.
        if (!draining.compareAndSet(false, true)) {
            // A message stored after the running drain last looked at the
            // queue would otherwise wait for the next SMS to be noticed.
            drainAgain.set(true)
            return
        }

        worker.execute {
            try {
                var delivered = 0
                while (true) {
                    val batch = outbox.claimReady(System.currentTimeMillis())
                    if (batch.isEmpty()) break

                    for (message in batch) {
                        val route = settings.routeFor(message.iccid)
                        if (route == null || route.receivers.isEmpty()) {
                            // Known SIM, nobody paired to it yet. Leave it
                            // queued: the owner may still be finishing pairing,
                            // and discarding it would lose a real message.
                            outbox.markFailed(message.id, "no_receiver", System.currentTimeMillis())
                            continue
                        }

                        // Every Receiver must have it before the row is done.
                        // Marking sent on partial delivery would silently drop
                        // a second reader's copy.
                        val results = try {
                            deposit(message, route)
                        } catch (e: Exception) {
                            // Fail this one row, or it would stop the queue
                            // behind it.
                            Log.e(TAG, "seal failed: ${e.javaClass.simpleName}")
                            if (e is IllegalArgumentException) {
                                // A stored key of the wrong shape. It will be
                                // just as wrong on the next attempt.
                                outbox.markDead(message.id, "seal_failed")
                            } else {
                                // Anything else may pass: a Keystore hiccup,
                                // settings that could not be read this once.
                                outbox.markFailed(message.id, "seal_error", System.currentTimeMillis())
                            }
                            continue
                        }

                        when {
                            results.all { it is DepositResult.Accepted } -> {
                                outbox.markSent(message.id)
                                delivered++
                            }
                            results.any { it is DepositResult.Rejected } -> {
                                // A bridge refused the message itself, and
                                // would refuse the same bytes again.
                                val reason = results.filterIsInstance<DepositResult.Rejected>()
                                    .first().reason
                                outbox.markDead(message.id, reason)
                            }
                            else -> outbox.markFailed(
                                message.id,
                                "unreachable",
                                System.currentTimeMillis(),
                            )
                        }
                    }
                    // Every failure path above advances next_attempt_at, so a
                    // batch that fails entirely is not re-claimed and this
                    // terminates instead of spinning against a dead network.
                    updateNotification(outbox.pendingCount())
                }

                val now = System.currentTimeMillis()
                outbox.purgeFinishedBefore(now - ARCHIVE_RETENTION_MILLIS)
                outbox.purgePendingBefore(now - PENDING_RETENTION_MILLIS)
                Log.i(TAG, "drain complete delivered=$delivered pending=${outbox.pendingCount()}")
            } catch (e: Exception) {
                // Never let the drain thread die: the service would stay alive
                // showing a healthy notification while delivering nothing.
                Log.e(TAG, "drain failed: ${e.javaClass.simpleName}")
            } finally {
                draining.set(false)
                if (drainAgain.getAndSet(false)) drain() else scheduleRetry()
            }
        }
    }

    /**
     * Wakes the drain when the earliest failed row is due.
     *
     * Without this a message that failed once would wait for the next SMS or a
     * reboot, since nothing else starts a drain. Runs on the worker, so it
     * never overlaps the drain it follows.
     */
    private fun scheduleRetry() {
        retry?.cancel(false)
        val dueAt = runCatching { outbox.nextAttemptAt() }.getOrNull() ?: return
        val delay = (dueAt - System.currentTimeMillis()).coerceAtLeast(MIN_RETRY_DELAY_MILLIS)
        retry = runCatching {
            worker.schedule(Runnable { drain() }, delay, TimeUnit.MILLISECONDS)
        }.getOrNull() // the worker is shut down when the service is destroyed
    }

    /** Seals one message to each of the SIM's Receivers and leaves it at the bridges. */
    private fun deposit(message: PendingMessage, route: SimRoute): List<DepositResult> {
        val id = Payload.wireId(
            settings.installSalt(),
            Outbox.dedupeKey(
                CapturedMessage(message.iccid, message.sender, message.body, message.receivedAt),
            ),
        )
        val payload = Payload(
            id = id,
            sim = route.label,
            from = message.sender,
            body = message.body,
            code = MessageClassifier.extractCode(message.body),
            at = message.receivedAt,
        ).encode()

        return route.receivers.map { receiver ->
            client.deposit(receiver.boxId, id, ReceiverSealer.fromBase64Url(receiver.publicKey).seal(payload))
        }
    }

    private fun notification(pending: Long): Notification {
        ensureChannel()
        val text = if (pending == 0L) {
            getString(R.string.notification_idle)
        } else {
            getString(R.string.notification_pending, pending)
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(pending: Long) {
        getSystemService(NotificationManager::class.java)
            ?.notify(NOTIFICATION_ID, notification(pending))
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel),
                // Low: this notification exists because Android requires one for
                // a foreground service, not because it is worth interrupting for.
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    companion object {
        private const val TAG = "EasyOTP"
        private const val CHANNEL_ID = "easyotp.forwarder"
        private const val NOTIFICATION_ID = 1

        /** Finished rows are history; the table must not grow without bound. */
        private const val ARCHIVE_RETENTION_MILLIS = 30L * 24 * 60 * 60 * 1000

        /** A message nobody could be sent for a week is dropped. */
        private const val PENDING_RETENTION_MILLIS = 7L * 24 * 60 * 60 * 1000

        /** Floor between drains, so a row that is always "due" cannot spin the loop. */
        private const val MIN_RETRY_DELAY_MILLIS = 1_000L

        /** Called by the capture path and on boot. Safe to call repeatedly. */
        fun wake(context: Context) {
            val intent = Intent(context, ForwarderService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
