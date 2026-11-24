package ir.rhinocloud.easyotp.data

import android.content.Context
import android.util.Base64
import ir.rhinocloud.easyotp.net.Bridge
import ir.rhinocloud.easyotp.net.HpkeKeyPair
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * A paired Receiver: someone who reads this phone's messages.
 *
 * The public key and box id are learned at pairing (DECISIONS D18, D24). The
 * public key is what a message is sealed to; the box id is where a bridge holds
 * it. Together they let a stranger put messages in front of this person, so
 * they are stored sealed like everything else here.
 *
 * The command fields are the other direction: a key pair and a box this Host
 * made for this one Receiver, so that it can ask the phone to ring or to report
 * (DECISIONS D26). Removing the Receiver forgets them, and with them its
 * ability to ask.
 */
data class Receiver(
    /** Made here, used only on this phone to tell Receivers apart. */
    val id: String,
    val label: String,
    /** X25519 public key, base64url. */
    val publicKey: String,
    val boxId: String,
    val commandKeys: HpkeKeyPair,
    /** Opens the box this Receiver leaves commands in. */
    val commandBoxKey: String,
    val pairedAt: Long,
    /**
     * The SIMs whose messages this Receiver gets, by routing key
     * ([ir.rhinocloud.easyotp.capture.SimRegistry.routingKey]). Null means
     * every SIM in the phone, including one put in later.
     */
    val sims: Set<String>? = null,
    /**
     * Whether this Receiver may make the phone send an SMS (DECISIONS D31).
     * Off unless the owner turns it on, here on the phone, for this one
     * Receiver: sending as someone's SIM is a different power from reading it.
     */
    val canSend: Boolean = false,
) {
    fun reads(simKey: String): Boolean = sims == null || simKey in sims
}

/** The stored settings exist but could not be opened. Nothing was changed. */
class SettingsUnreadable(cause: Throwable) : IllegalStateException("stored settings could not be opened", cause)

/**
 * All of the Host's configuration.
 *
 * Everything lives on the phone because a bridge keeps no accounts (DECISIONS
 * D16). The blob is sealed with the Keystore key before it touches disk.
 */
class Settings(
    context: Context,
    private val vault: KeyVault = KeyVault(alias = "easyotp.settings.v1"),
) {
    private val prefs = context.applicationContext
        .getSharedPreferences("easyotp.settings", Context.MODE_PRIVATE)

    /** The bridges to send through. The seed list until a signed list replaces it (D17). */
    var bridges: List<Bridge>
        get() = read().optJSONArray(KEY_BRIDGES)
            ?.let { array ->
                (0 until array.length()).map {
                    val o = array.getJSONObject(it)
                    Bridge(o.getString("id"), o.getString("baseUrl"))
                }
            }
            ?.takeIf { it.isNotEmpty() }
            ?: SEED_BRIDGES
        set(value) = mutate {
            put(
                KEY_BRIDGES,
                JSONArray().apply {
                    value.forEach { put(JSONObject().put("id", it.id).put("baseUrl", it.baseUrl)) }
                },
            )
        }

    /**
     * Random bytes made once per install and never sent anywhere. They keep the
     * id a message travels under from meaning anything to a bridge; see
     * `Payload.wireId`.
     */
    fun installSalt(): ByteArray = synchronized(LOCK) {
        // Strict: a salt invented because the real one could not be read this
        // once would change the id of every message still in the queue.
        val stored = readStrict().optString(KEY_SALT)
        if (stored.isNotBlank()) return Base64.decode(stored, Base64.NO_WRAP)
        val fresh = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
        mutate { put(KEY_SALT, Base64.encodeToString(fresh, Base64.NO_WRAP)) }
        fresh
    }

    /** What Receivers see this phone called. Part of the pairing picture. */
    var hostLabel: String
        get() = read().optString(KEY_LABEL)
        set(value) = mutate { put(KEY_LABEL, value) }

    /**
     * The owner has confirmed they may forward this phone's messages. Nothing
     * is captured before that. Where a SIM belongs to someone else, which is
     * the household case this was built for, consent recorded at setup is the
     * minimum defensible posture (THREAT-MODEL, "Legal and consent").
     */
    var consent: Boolean
        get() = read().optBoolean(KEY_CONSENT, false)
        set(value) = mutate { put(KEY_CONSENT, value) }

    /** For showing. Unreadable settings read as nobody paired. */
    fun receivers(): List<Receiver> = receiversIn(read())

    /**
     * For deciding. Throws [SettingsUnreadable] rather than answer "nobody":
     * the service stops itself when nobody is paired, and must not do that
     * because the Keystore failed once.
     */
    fun receiversStrict(): List<Receiver> = receiversIn(readStrict())

    /**
     * Who gets a message from this SIM, for the capture and delivery paths.
     * Throws [SettingsUnreadable] rather than answer "nobody": a message
     * dropped because the Keystore failed once would be lost for good.
     */
    fun receiversFor(simKey: String): List<Receiver> {
        val stored = readStrict()
        if (!stored.optBoolean(KEY_CONSENT, false)) return emptyList()
        return receiversIn(stored).filter { it.reads(simKey) }
    }

    fun addReceiver(receiver: Receiver) = mutate { putReceivers(receiversIn(this) + receiver) }

    fun removeReceiver(id: String) = mutate { putReceivers(receiversIn(this).filter { it.id != id }) }

    fun setReceiverSims(id: String, sims: Set<String>?) = mutate {
        putReceivers(receiversIn(this).map { if (it.id == id) it.copy(sims = sims) else it })
    }

    fun setReceiverCanSend(id: String, canSend: Boolean) = mutate {
        putReceivers(receiversIn(this).map { if (it.id == id) it.copy(canSend = canSend) else it })
    }

    /** Whether calls to this phone are told to its Receivers, and may be declined by them (DECISIONS D31). */
    var calls: Boolean
        get() = read().optBoolean(KEY_CALLS, false)
        set(value) = mutate { put(KEY_CALLS, value) }

    private fun receiversIn(stored: JSONObject): List<Receiver> {
        val array = stored.optJSONArray(KEY_RECEIVERS) ?: return emptyList()
        return (0 until array.length()).map { i ->
            val r = array.getJSONObject(i)
            val sims = r.optJSONArray("sims")
            Receiver(
                id = r.getString("id"),
                label = r.optString("label"),
                publicKey = r.getString("publicKey"),
                boxId = r.getString("boxId"),
                commandKeys = HpkeKeyPair(r.getString("commandPublicKey"), r.getString("commandPrivateKey")),
                commandBoxKey = r.getString("commandBoxKey"),
                pairedAt = r.optLong("pairedAt"),
                sims = sims?.let { (0 until it.length()).map(it::getString).toSet() },
                canSend = r.optBoolean("canSend", false),
            )
        }
    }

    private fun JSONObject.putReceivers(receivers: List<Receiver>) {
        put(
            KEY_RECEIVERS,
            JSONArray().apply {
                receivers.forEach { r ->
                    put(
                        JSONObject()
                            .put("id", r.id)
                            .put("label", r.label)
                            .put("publicKey", r.publicKey)
                            .put("boxId", r.boxId)
                            .put("commandPublicKey", r.commandKeys.publicKey)
                            .put("commandPrivateKey", r.commandKeys.privateKey)
                            .put("commandBoxKey", r.commandBoxKey)
                            .put("pairedAt", r.pairedAt)
                            .put("canSend", r.canSend)
                            // Absent, not empty: absent means every SIM.
                            .apply { r.sims?.let { put("sims", JSONArray(it.toList())) } },
                    )
                }
            },
        )
    }

    /** Used by the panic path: forget every pairing without touching the queue. */
    fun clear() = prefs.edit().clear().apply()

    /**
     * For showing and routing. Unreadable settings read as empty, so the app
     * starts and can say that nothing is paired instead of crashing on launch.
     */
    private fun read(): JSONObject = runCatching { readStrict() }.getOrElse { JSONObject() }

    /** For anything that writes. Throws rather than treat unreadable as empty. */
    private fun readStrict(): JSONObject {
        val stored = prefs.getString(KEY_BLOB, null) ?: return JSONObject()
        return try {
            JSONObject(String(vault.open(Base64.decode(stored, Base64.NO_WRAP))))
        } catch (e: Exception) {
            throw SettingsUnreadable(e)
        }
    }

    /**
     * Changes are applied to what is stored, so they need what is stored. If it
     * cannot be opened, writing "empty plus this change" over it would erase
     * every pairing because of one failed Keystore read. [clear] is the way to
     * start again on purpose.
     */
    private fun mutate(block: JSONObject.() -> Unit) = synchronized(LOCK) {
        val next = readStrict().apply(block)
        val sealed = Base64.encodeToString(vault.seal(next.toString().toByteArray()), Base64.NO_WRAP)
        prefs.edit().putString(KEY_BLOB, sealed).apply()
    }

    companion object {
        /**
         * Every change is read, alter, write back, and the screens, the
         * capture path and the service each hold their own instance. One lock
         * for the process, or a change made between another's read and write
         * is undone: a Receiver just removed would be paired again.
         */
        private val LOCK = Any()

        private const val KEY_BLOB = "sealed"
        private const val KEY_BRIDGES = "bridges"
        private const val KEY_RECEIVERS = "receivers"
        private const val KEY_LABEL = "hostLabel"
        private const val KEY_CONSENT = "consent"
        private const val KEY_CALLS = "calls"
        private const val KEY_SALT = "installSalt"
        private const val SALT_BYTES = 32

        /**
         * The bridges as they stood when this APK was built (DECISIONS D17).
         *
         * Both names answer over HTTPS with a certificate that covers them.
         * Change one only with care: an installed phone starts from this list.
         */
        val SEED_BRIDGES = listOf(
            Bridge("arsalan", "https://easyotp.arsalan.finlawgpt.ir"),
            Bridge("cfworker", "https://easyotp.cfworker.rhinocloud.ir"),
        )
    }
}
