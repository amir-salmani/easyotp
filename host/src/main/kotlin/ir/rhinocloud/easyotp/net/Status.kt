package ir.rhinocloud.easyotp.net

import org.json.JSONObject

/**
 * This phone's report on itself (DECISIONS D26). Sent every [every] seconds and
 * whenever a Receiver asks, so that a dead battery is seen before the day a
 * code does not arrive.
 *
 * The fields must match `Status` in receiver/src/open.ts. Like [Payload], a
 * report sealed here is opened there in CI on every run.
 */
data class HostStatus(
    val id: String,
    val at: Long,
    /** How often to expect a report, in seconds. Silence for much longer means trouble. */
    val every: Int,
    /** 0 to 100, or null if the phone will not say. */
    val battery: Int?,
    val charging: Boolean?,
    /** "wifi", "cell", "none", or null if unknown. */
    val net: String?,
    /** SMS captured and not yet delivered to a bridge. */
    val pending: Long,
    /** The command this report answers, if it answers one. */
    val ack: String? = null,
) {
    fun encode(): ByteArray = JSONObject()
        .put("v", 2)
        .put("k", "status")
        .put("id", id)
        .put("at", at)
        .put("every", every)
        // An explicit null, not an absent key: the Receiver checks for one.
        .put("battery", battery ?: JSONObject.NULL)
        .put("charging", charging ?: JSONObject.NULL)
        .put("net", net ?: JSONObject.NULL)
        .put("pending", pending)
        .apply { if (ack != null) put("ack", ack) }
        .toString()
        .toByteArray()

    companion object {
        /** A bridge keeps only the newest message carrying this tag. */
        const val TAG = "status"
    }
}

/** Something a paired Receiver asks this phone to do. */
data class Command(val id: String, val at: Long, val what: What) {
    enum class What { BUZZ, PING }
}

/**
 * Opens the commands one Receiver sends.
 *
 * A command is obeyed once however many bridges deliver it, and only if the id
 * inside the seal is the id it arrived under: otherwise a bridge could replay
 * one old "ring" under new ids for ever.
 */
class CommandInbox(private val keys: HpkeKeyPair) {

    private val seen = LinkedHashSet<String>()

    /** The command, or null if this is not one, is not for this key, or was already obeyed. */
    @Synchronized
    fun accept(envelopeId: String, enc: String, ct: String): Command? {
        val command = runCatching {
            val m = JSONObject(String(Hpke.open(keys, enc, ct) ?: return null, Charsets.UTF_8))
            if (m.optInt("v") != 2 || m.optString("k") != "cmd" || m.optString("id") != envelopeId) return null
            val what = when (m.optString("cmd")) {
                "buzz" -> Command.What.BUZZ
                "ping" -> Command.What.PING
                else -> return null
            }
            Command(envelopeId, m.optLong("at"), what)
        }.getOrNull() ?: return null

        if (!seen.add(command.id)) return null
        if (seen.size > REMEMBERED) seen.iterator().let { it.next(); it.remove() }
        return command
    }

    private companion object {
        const val REMEMBERED = 200
    }
}
