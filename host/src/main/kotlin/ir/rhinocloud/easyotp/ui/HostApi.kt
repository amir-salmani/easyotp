package ir.rhinocloud.easyotp.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.util.Log
import android.webkit.JavascriptInterface
import ir.rhinocloud.easyotp.capture.SimRegistry
import ir.rhinocloud.easyotp.data.Outbox
import ir.rhinocloud.easyotp.data.Receiver
import ir.rhinocloud.easyotp.data.Settings
import ir.rhinocloud.easyotp.net.Hpke
import ir.rhinocloud.easyotp.net.HpkeKeyPair
import ir.rhinocloud.easyotp.net.ReceiverSealer
import ir.rhinocloud.easyotp.pair.HostPairing
import ir.rhinocloud.easyotp.pair.HttpSlotTransport
import ir.rhinocloud.easyotp.pair.PairCodec
import ir.rhinocloud.easyotp.pair.PairedReceiver
import ir.rhinocloud.easyotp.pair.PairingFailed
import ir.rhinocloud.easyotp.service.Buzzer
import ir.rhinocloud.easyotp.service.ForwarderService
import ir.rhinocloud.easyotp.service.HostEvents
import ir.rhinocloud.easyotp.service.ObeyedCommands
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.Executors

/**
 * Everything the Host's screens can ask of the phone, and nothing else.
 *
 * The screens are a web page with no network access of their own (see
 * `WebShell`). They never hold a key: [state] tells them what to draw, and the
 * other methods are the buttons. This is the whole surface between the part of
 * the app that can change without a new APK and the part that cannot
 * (DECISIONS D19), so it is kept small and every method takes plain values.
 *
 * Its twin is `receiver/src/host-app/native.ts`, which says the same in
 * TypeScript and stands in for it in a browser.
 */
class HostApi(private val activity: MainActivity) {

    private val context: Context = activity.applicationContext
    private val settings = Settings(context)

    /** Everything the screens show, as JSON. Called again after every `easyotp:change`. */
    @JavascriptInterface
    fun state(): String {
        val sims = runCatching { SimRegistry(context) }.getOrNull()
        val pair = session
        return JSONObject()
            .put("version", versionName())
            .put("label", label())
            .put("consent", settings.consent)
            .put(
                "perms",
                JSONObject()
                    .put("sms", granted(Manifest.permission.RECEIVE_SMS))
                    .put("phone", granted(Manifest.permission.READ_PHONE_STATE))
                    .put("notify", Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS))
                    .put("battery", context.getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(context.packageName) ?: true),
            )
            .put(
                "sims",
                JSONArray().apply {
                    sims?.activeSims()?.forEach { put(JSONObject().put("key", it.iccid).put("name", sims.labelFor(it.iccid))) }
                },
            )
            .put(
                "receivers",
                JSONArray().apply {
                    settings.receivers().forEach { r ->
                        put(
                            JSONObject().put("id", r.id).put("label", r.label).put("pairedAt", r.pairedAt)
                                .put("sims", r.sims?.let { JSONArray(it.toList()) } ?: JSONObject.NULL),
                        )
                    }
                },
            )
            .put("pending", runCatching { Outbox(context).pendingCount() }.getOrDefault(0L))
            .put("test", HostEvents.lastTest?.let { JSONObject().put("ok", it.ok).put("at", it.at) } ?: JSONObject.NULL)
            // While the phone rings, the screens say who asked and offer to stop it.
            .put("ring", Buzzer.ringingFor?.let { JSONObject().put("from", it) } ?: JSONObject.NULL)
            .put("pair", pair?.toJson() ?: JSONObject.NULL)
            .toString()
    }

    /** Asks Android for one thing. The answer arrives as an `easyotp:change`. */
    @JavascriptInterface
    fun ask(what: String) = activity.runOnUiThread {
        runCatching {
            when (what) {
                "sms" -> activity.requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS), 1)
                "phone" -> activity.requestPermissions(arrayOf(Manifest.permission.READ_PHONE_STATE), 2)
                "notify" -> if (Build.VERSION.SDK_INT >= 33) {
                    activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 3)
                }
                // Android shows its own yes-or-no question for this one.
                "battery" -> activity.startActivity(
                    Intent(AndroidSettings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")),
                )
                // Where a permission refused twice, or held back from an app
                // installed outside the store, can still be turned on by hand.
                "settings" -> activity.startActivity(
                    Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")),
                )
            }
        }.onFailure { Log.w(TAG, "ask $what: ${it.javaClass.simpleName}") }
    }

    @JavascriptInterface
    fun setLabel(label: String) = change { settings.hostLabel = PairCodec.cleanLabel(label) }

    @JavascriptInterface
    fun setConsent(agreed: Boolean) = change { settings.consent = agreed }

    /** Shows a code and waits for a Receiver. Progress is in [state] under `pair`. */
    @JavascriptInterface
    fun pairStart() {
        synchronized(LOCK) {
            if (session?.stage == Stage.WAITING) return
            session?.pairing?.cancel()
            val commandKeys = Hpke.newKeyPair()
            val commandBoxKey = randomKey(32)
            val code = HostPairing.newCode()
            val pairing = HostPairing(
                bridges = settings.bridges.map { it.baseUrl },
                transport = HttpSlotTransport(),
                code = code,
                label = label(),
                commandPublicKey = commandKeys.publicKey,
                commandBoxId = PairCodec.boxId(commandBoxKey),
            )
            val mine = Session(code, commandKeys, commandBoxKey, pairing)
            session = mine
            WORKER.execute {
                try {
                    val found = pairing.run()
                    synchronized(LOCK) { if (session === mine) { mine.found = found; mine.stage = Stage.PICTURE } }
                } catch (e: PairingFailed) {
                    synchronized(LOCK) {
                        if (session === mine) {
                            if (e.reason == PairingFailed.CANCELLED) session = null else { mine.stage = Stage.FAILED; mine.reason = e.reason }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "pairing: ${e.javaClass.simpleName}")
                    synchronized(LOCK) { if (session === mine) { mine.stage = Stage.FAILED; mine.reason = PairingFailed.UNREACHABLE } }
                }
                HostEvents.changed()
            }
        }
        HostEvents.changed()
    }

    /**
     * The person compared the pictures. Only "the same" stores anything.
     *
     * @return the new Receiver's id, or an empty string.
     */
    @JavascriptInterface
    fun pairAnswer(same: Boolean): String {
        val done = synchronized(LOCK) { session.also { session = null } }
        val found = done?.found
        var id = ""
        if (same && done != null && found != null) {
            id = randomKey(12)
            runCatching {
                settings.addReceiver(
                    Receiver(
                        id = id,
                        label = found.label,
                        publicKey = found.publicKey,
                        boxId = found.boxId,
                        commandKeys = done.commandKeys,
                        commandBoxKey = done.commandBoxKey,
                        pairedAt = System.currentTimeMillis(),
                    ),
                )
                ForwarderService.wake(context, ForwarderService.ACTION_RELOAD)
            }.onFailure {
                Log.e(TAG, "store receiver: ${it.javaClass.simpleName}")
                id = ""
            }
        }
        HostEvents.changed()
        return id
    }

    @JavascriptInterface
    fun pairCancel() {
        synchronized(LOCK) { session.also { session = null } }?.pairing?.cancel()
        HostEvents.changed()
    }

    /** @param sims a JSON array of SIM keys, or the text `null` for every SIM. */
    @JavascriptInterface
    fun setReceiverSims(id: String, sims: String) = change {
        val chosen = if (sims == "null") null else JSONArray(sims).let { a -> (0 until a.length()).map(a::getString).toSet() }
        settings.setReceiverSims(id, chosen)
    }

    @JavascriptInterface
    fun removeReceiver(id: String) = change {
        settings.removeReceiver(id)
        ObeyedCommands.forget(context, id)
        ForwarderService.wake(context, ForwarderService.ACTION_RELOAD)
    }

    /** Sends every Receiver a test message. The result is in [state] under `test`. */
    @JavascriptInterface
    fun sendTest() = ForwarderService.wake(context, ForwarderService.ACTION_TEST)

    /** Whoever is holding the phone has heard it ring. */
    @JavascriptInterface
    fun stopRing() {
        Buzzer.silence(context)
        context.getSystemService(android.app.NotificationManager::class.java)?.cancel(ForwarderService.RING_NOTIFICATION_ID)
    }

    /** Leaves the app, when the page has nothing left for Back to close. */
    @JavascriptInterface
    fun exit() = activity.runOnUiThread { activity.finish() }

    private fun change(block: () -> Unit) {
        runCatching(block).onFailure { Log.e(TAG, "change: ${it.javaClass.simpleName}") }
        HostEvents.changed()
    }

    private fun label(): String = settings.hostLabel.ifBlank { PairCodec.cleanLabel(Build.MODEL) }

    private fun granted(permission: String) = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun versionName(): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull().orEmpty()

    private fun randomKey(bytes: Int) = ReceiverSealer.base64UrlEncode(ByteArray(bytes).also { SecureRandom().nextBytes(it) })

    private enum class Stage { WAITING, PICTURE, FAILED }

    /** One attempt at pairing, from showing the code to the person's answer. */
    private class Session(
        val code: String,
        val commandKeys: HpkeKeyPair,
        val commandBoxKey: String,
        val pairing: HostPairing,
    ) {
        var stage = Stage.WAITING
        var found: PairedReceiver? = null
        var reason: String? = null

        fun toJson(): JSONObject = JSONObject()
            .put("stage", stage.name.lowercase())
            .put("code", code)
            .put("sas", found?.let { PairCodec.b64(it.sas) } ?: JSONObject.NULL)
            .put("peer", found?.label ?: JSONObject.NULL)
            .put("reason", reason ?: JSONObject.NULL)
    }

    private companion object {
        const val TAG = "EasyOTP"
        val LOCK = Any()
        val WORKER = Executors.newCachedThreadPool()

        /** Outlives the window, so turning the phone does not lose a pairing in progress. */
        @Volatile
        var session: Session? = null
    }
}
