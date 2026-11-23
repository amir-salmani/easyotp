package ir.rhinocloud.easyotp.net

import org.json.JSONObject
import java.security.MessageDigest

/**
 * One SMS, as the Receiver will read it once it opens the seal.
 *
 * The fields must match `Message` in receiver/src/open.ts. A fixture built by
 * [encode], sealed here and opened there, is regenerated in CI on every run, so
 * a field that drifts on either side fails the build.
 */
data class Payload(
    /** Also sent to the bridge in the clear. See [wireId]. */
    val id: String,
    /** The label the owner gave the SIM, so the reader knows whose line it was. */
    val sim: String,
    val from: String,
    val body: String,
    /** The one-time code found in the body, if any, so the Receiver can offer to copy it. */
    val code: String?,
    /** When the phone received the SMS, in milliseconds. */
    val at: Long,
) {
    fun encode(): ByteArray = JSONObject()
        .put("v", 2)
        .put("id", id)
        .put("sim", sim)
        .put("from", from)
        .put("body", body)
        // An absent key and an explicit null are different to the Receiver.
        .put("code", code ?: JSONObject.NULL)
        .put("at", at)
        .toString()
        .toByteArray()

    companion object {
        /**
         * The id a message travels under.
         *
         * A bridge sees this id, and the outbox's own key is a plain hash of
         * the SIM, the sender and the text, which a bridge could test guesses
         * against. Mixing in a salt that never leaves this phone makes the id
         * mean nothing to anyone else, while staying the same on every retry
         * and at every bridge, which is what lets the Receiver show a message
         * once.
         */
        fun wireId(installSalt: ByteArray, dedupeKey: String): String {
            val digest = MessageDigest.getInstance("SHA-256").apply {
                update(installSalt)
                update(dedupeKey.toByteArray())
            }.digest()
            return ReceiverSealer.base64UrlEncode(digest.copyOf(WIRE_ID_BYTES))
        }

        /** 24 bytes is 32 characters of base64url, inside the bridge's 16 to 64. */
        private const val WIRE_ID_BYTES = 24
    }
}
