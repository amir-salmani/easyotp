package ir.rhinocloud.easyotp.data

import android.content.Context
import android.util.Base64
import ir.rhinocloud.easyotp.net.Bridge
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * A paired Receiver: who reads one SIM's messages.
 *
 * Both values are learned at pairing (DECISIONS D18). The public key is what a
 * message is sealed to; the box id is where a bridge holds it. Neither lets
 * anyone read anything, but together they let a stranger put messages in front
 * of this person, so they are stored sealed like everything else here.
 */
data class Receiver(
    val label: String,
    /** X25519 public key, base64url. */
    val publicKey: String,
    val boxId: String,
)

/**
 * A SIM and who receives its messages, keyed by ICCID.
 *
 * [consentAcknowledged] records that the operator confirmed they may forward this
 * line's messages. Where a SIM belongs to someone else -- the household case this
 * was built for -- consent recorded at setup is the minimum defensible posture
 * (THREAT-MODEL, "Legal and consent").
 */
data class SimRoute(
    val iccid: String,
    val label: String,
    val receivers: List<Receiver>,
    val consentAcknowledged: Boolean = false,
)

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
    fun installSalt(): ByteArray {
        // Strict: a salt invented because the real one could not be read this
        // once would change the id of every message still in the queue.
        val stored = readStrict().optString(KEY_SALT)
        if (stored.isNotBlank()) return Base64.decode(stored, Base64.NO_WRAP)
        val fresh = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
        mutate { put(KEY_SALT, Base64.encodeToString(fresh, Base64.NO_WRAP)) }
        return fresh
    }

    fun routes(): List<SimRoute> {
        val array = read().optJSONArray(KEY_ROUTES) ?: return emptyList()
        return (0 until array.length()).map { i ->
            val o = array.getJSONObject(i)
            val receivers = o.optJSONArray("receivers") ?: JSONArray()
            SimRoute(
                iccid = o.getString("iccid"),
                label = o.optString("label"),
                consentAcknowledged = o.optBoolean("consent", false),
                receivers = (0 until receivers.length()).map { j ->
                    val r = receivers.getJSONObject(j)
                    Receiver(
                        label = r.optString("label"),
                        publicKey = r.getString("publicKey"),
                        boxId = r.getString("boxId"),
                    )
                },
            )
        }
    }

    /**
     * The route for a SIM, or null when the SIM is unknown or consent has not
     * been acknowledged. A message with nowhere to go stays queued rather than
     * being guessed at -- the same rule the capture path applies to messages it
     * cannot attribute to a SIM.
     */
    fun routeFor(iccid: String): SimRoute? =
        routes().firstOrNull { it.iccid == iccid && it.consentAcknowledged }

    fun putRoute(route: SimRoute) = mutate {
        val existing = routes().filter { it.iccid != route.iccid } + route
        put(
            KEY_ROUTES,
            JSONArray().apply {
                existing.forEach { r ->
                    put(
                        JSONObject()
                            .put("iccid", r.iccid)
                            .put("label", r.label)
                            .put("consent", r.consentAcknowledged)
                            .put(
                                "receivers",
                                JSONArray().apply {
                                    r.receivers.forEach { receiver ->
                                        put(
                                            JSONObject()
                                                .put("label", receiver.label)
                                                .put("publicKey", receiver.publicKey)
                                                .put("boxId", receiver.boxId),
                                        )
                                    }
                                },
                            ),
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
    private fun mutate(block: JSONObject.() -> Unit) {
        val next = readStrict().apply(block)
        val sealed = Base64.encodeToString(vault.seal(next.toString().toByteArray()), Base64.NO_WRAP)
        prefs.edit().putString(KEY_BLOB, sealed).apply()
    }

    companion object {
        private const val KEY_BLOB = "sealed"
        private const val KEY_BRIDGES = "bridges"
        private const val KEY_ROUTES = "routes"
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
