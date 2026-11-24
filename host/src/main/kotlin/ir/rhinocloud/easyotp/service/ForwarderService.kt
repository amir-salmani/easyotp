package ir.rhinocloud.easyotp.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import ir.rhinocloud.easyotp.R
import ir.rhinocloud.easyotp.capture.MessageClassifier
import ir.rhinocloud.easyotp.capture.SimRegistry
import ir.rhinocloud.easyotp.data.CapturedMessage
import ir.rhinocloud.easyotp.data.Outbox
import ir.rhinocloud.easyotp.data.PendingMessage
import ir.rhinocloud.easyotp.data.Settings
import ir.rhinocloud.easyotp.data.Receiver
import ir.rhinocloud.easyotp.net.BridgeClient
import ir.rhinocloud.easyotp.net.BridgeHealth
import ir.rhinocloud.easyotp.net.Command
import ir.rhinocloud.easyotp.net.CommandListener
import ir.rhinocloud.easyotp.net.DepositResult
import ir.rhinocloud.easyotp.net.HostStatus
import ir.rhinocloud.easyotp.net.Payload
import ir.rhinocloud.easyotp.net.ReceiverSealer
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Drains the outbox, reports on the phone, and waits for commands.
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

    /**
     * Reports, sweeps and rings run here, off the drain's thread: a report to
     * a bridge that is not answering must not hold an SMS behind it.
     */
    private val side = Executors.newCachedThreadPool()

    /** One per paired Receiver, by its id. Touched only on the main thread. */
    private val listeners = HashMap<String, CommandListener>()

    private val awake by lazy {
        getSystemService(PowerManager::class.java)
            ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "easyotp:work")
            ?.apply { setReferenceCounted(false) }
    }

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
        // Whatever woke the phone lets go of it as soon as this returns, and
        // the work below is on other threads. Timed, so it cannot be leaked.
        runCatching { awake?.acquire(AWAKE_MILLIS) }

        StatusAlarm.schedule(this)
        val receivers = try {
            settings.receiversStrict()
        } catch (e: Exception) {
            // The settings could not be opened this once. That is not "nobody
            // is paired": keep whatever is running, send what is queued, and
            // let the next wake read them again.
            Log.w(TAG, "settings unreadable: ${e.javaClass.simpleName}")
            drain()
            return START_STICKY
        }
        if (receivers.isEmpty()) {
            // Nobody is paired, so there is nothing to forward, report or obey.
            // A phone that was never set up should not carry a notification.
            listen(emptyList())
            StatusAlarm.cancel(this)
            // What was captured for someone since removed goes to nobody,
            // and above all not to whoever is paired next.
            runCatching { worker.execute { runCatching { outbox.abandonPending("no_receiver") } } }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        listen(receivers)
        when (intent?.action) {
            ACTION_SILENCE -> {
                Buzzer.silence(this)
                getSystemService(NotificationManager::class.java)?.cancel(RING_NOTIFICATION_ID)
            }
            ACTION_STATUS -> {
                report(receivers, ack = null)
                listeners.values.forEach { listener -> side.execute { runCatching { listener.sweep() } } }
            }
            // Someone was just paired or removed. The new one should see this
            // phone alive at once, not at the next alarm.
            ACTION_RELOAD -> report(receivers, ack = null)
            ACTION_TEST -> sendTest(receivers)
        }
        drain()
        // Restart if killed, but without redelivering the intent: the work to do
        // is whatever is in the outbox, not whatever this particular intent said.
        return START_STICKY
    }

    override fun onDestroy() {
        listen(emptyList())
        side.shutdownNow()
        // Not shutdownNow: giving up queued rows may still be waiting to run.
        worker.shutdown()
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
                        // Every Receiver must have it before the row is done.
                        // Marking sent on partial delivery would silently drop
                        // a second reader's copy.
                        val results = try {
                            val receivers = settings.receiversFor(message.iccid)
                            if (receivers.isEmpty()) {
                                // Whoever read this SIM was removed after the
                                // message was captured. It has nowhere to go.
                                outbox.markDead(message.id, "no_receiver")
                                continue
                            }
                            deposit(message, receivers)
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
    private fun deposit(message: PendingMessage, receivers: List<Receiver>): List<DepositResult> {
        val id = Payload.wireId(
            settings.installSalt(),
            Outbox.dedupeKey(
                CapturedMessage(message.iccid, message.sender, message.body, message.receivedAt),
            ),
        )
        val payload = Payload(
            id = id,
            sim = SimRegistry(this).labelFor(message.iccid),
            from = message.sender,
            body = message.body,
            code = MessageClassifier.extractCode(message.body),
            at = message.receivedAt,
        ).encode()

        return receivers.map { receiver ->
            client.deposit(receiver.boxId, id, ReceiverSealer.fromBase64Url(receiver.publicKey).seal(payload))
        }
    }

    /** Starts a listener for each Receiver that has none, and stops those whose Receiver is gone. */
    private fun listen(receivers: List<Receiver>) {
        val wanted = receivers.associateBy { it.id }
        listeners.keys.filter { it !in wanted }.forEach { listeners.remove(it)?.stop() }
        val bridges = runCatching { settings.bridges }.getOrDefault(Settings.SEED_BRIDGES)
        wanted.filterKeys { it !in listeners }.forEach { (id, receiver) ->
            listeners[id] = CommandListener(bridges, receiver, ::obey, ObeyedCommands(this, id)).apply { start() }
        }
    }

    /** Called on a listener's thread. */
    private fun obey(receiver: Receiver, command: Command) {
        Log.i(TAG, "command ${command.what}")
        runCatching { awake?.acquire(AWAKE_MILLIS) }
        if (command.what == Command.What.BUZZ) {
            Buzzer.ring(this, receiver.label)
            notifyRing(receiver.label)
        }
        // The answer names the command, which is how the person who pressed
        // the button knows this phone really did it.
        report(listOf(receiver), ack = command.id)
    }

    /** Tells Receivers how this phone is doing (DECISIONS D26). */
    private fun report(receivers: List<Receiver>, ack: String?) {
        runCatching {
            side.execute {
                try {
                    val battery = DeviceState.battery(this)
                    val status = HostStatus(
                        id = randomId(),
                        at = System.currentTimeMillis(),
                        every = StatusAlarm.EVERY_SECONDS,
                        battery = battery.percent,
                        charging = battery.charging,
                        net = DeviceState.network(this),
                        pending = outbox.pendingCount(),
                        ack = ack,
                    )
                    val payload = status.encode()
                    receivers.forEach { receiver ->
                        client.deposit(
                            receiver.boxId, status.id,
                            ReceiverSealer.fromBase64Url(receiver.publicKey).seal(payload),
                            tag = HostStatus.TAG,
                        )
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "report failed: ${e.javaClass.simpleName}")
                }
            }
        }
    }

    /**
     * Sends every Receiver a message that says it is a test, by the same path
     * an SMS takes from the seal onwards. The owner presses a button and sees,
     * on the phone, whether a bridge took it.
     */
    private fun sendTest(receivers: List<Receiver>) {
        runCatching {
            side.execute {
                val ok = try {
                    val id = randomId()
                    val payload = Payload(
                        id = id,
                        sim = getString(R.string.test_sim),
                        from = "EasyOTP",
                        body = getString(R.string.test_body, settings.hostLabel),
                        code = null,
                        at = System.currentTimeMillis(),
                    ).encode()
                    receivers.map { receiver ->
                        client.deposit(receiver.boxId, id, ReceiverSealer.fromBase64Url(receiver.publicKey).seal(payload))
                    }.all { it is DepositResult.Accepted }
                } catch (e: Exception) {
                    Log.e(TAG, "test failed: ${e.javaClass.simpleName}")
                    false
                }
                HostEvents.testFinished(ok, System.currentTimeMillis())
            }
        }
    }

    private fun randomId(): String =
        ReceiverSealer.base64UrlEncode(ByteArray(WIRE_ID_BYTES).also { SecureRandom().nextBytes(it) })

    private fun notifyRing(from: String) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(RING_CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(RING_CHANNEL_ID, getString(R.string.ring_channel), NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val silence = PendingIntent.getService(
            this, 0, Intent(this, ForwarderService::class.java).setAction(ACTION_SILENCE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        runCatching {
            manager.notify(
                RING_NOTIFICATION_ID,
                Notification.Builder(this, RING_CHANNEL_ID)
                    .setContentTitle(getString(R.string.app_name))
                    // Whoever picks the phone up should see why it rang.
                    .setContentText(getString(R.string.ring_text, from))
                    .setSmallIcon(android.R.drawable.stat_notify_more)
                    // Tapping it, its button, or swiping it away all stop the ring.
                    .setContentIntent(silence)
                    .setDeleteIntent(silence)
                    .addAction(Notification.Action.Builder(null, getString(R.string.ring_stop), silence).build())
                    .setAutoCancel(true)
                    .build(),
            )
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
        private const val RING_CHANNEL_ID = "easyotp.ring"
        const val RING_NOTIFICATION_ID = 2

        /** Report on the phone now, and look at every bridge for commands. */
        const val ACTION_STATUS = "ir.rhinocloud.easyotp.STATUS"

        /** The list of paired Receivers changed. */
        const val ACTION_RELOAD = "ir.rhinocloud.easyotp.RELOAD"

        /** Someone at the phone wants the ring to stop. */
        const val ACTION_SILENCE = "ir.rhinocloud.easyotp.SILENCE"

        /** Send every Receiver a test message. */
        const val ACTION_TEST = "ir.rhinocloud.easyotp.TEST"

        /** Longer than one deposit can take; see BridgeClient's timeouts. */
        private const val AWAKE_MILLIS = 60_000L

        /** The same length as an SMS's id; see Payload.wireId. */
        private const val WIRE_ID_BYTES = 24

        /** Finished rows are history; the table must not grow without bound. */
        private const val ARCHIVE_RETENTION_MILLIS = 30L * 24 * 60 * 60 * 1000

        /** A message nobody could be sent for a week is dropped. */
        private const val PENDING_RETENTION_MILLIS = 7L * 24 * 60 * 60 * 1000

        /** Floor between drains, so a row that is always "due" cannot spin the loop. */
        private const val MIN_RETRY_DELAY_MILLIS = 1_000L

        /**
         * Called by the capture path, on boot, by the alarm and by the screens.
         * Safe to call repeatedly.
         */
        fun wake(context: Context, action: String? = null) {
            val intent = Intent(context, ForwarderService::class.java).setAction(action)
            try {
                context.startForegroundService(intent)
            } catch (e: Exception) {
                // Android may refuse to start a foreground service from the
                // background. A running service is unaffected, and what was
                // captured is already stored; the next wake carries it.
                Log.w(TAG, "wake refused: ${e.javaClass.simpleName}")
            }
        }
    }
}
