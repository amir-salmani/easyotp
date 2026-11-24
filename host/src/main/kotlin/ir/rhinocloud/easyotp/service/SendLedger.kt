package ir.rhinocloud.easyotp.service

import android.content.Context
import ir.rhinocloud.easyotp.net.ReceiverSealer
import java.security.MessageDigest

/**
 * The two things [SendPolicy] needs remembered: who has contacted each SIM,
 * and how often each Receiver has made the phone send.
 *
 * Who contacted a SIM is kept as a salted hash and a time, never the number.
 * The question asked of it is only ever "has this exact number been heard
 * from", so the number itself has no reason to be on disk a second time.
 */
class SendLedger(context: Context, private val salt: ByteArray) {

    private val heard = context.applicationContext.getSharedPreferences("easyotp.heard", Context.MODE_PRIVATE)
    private val sent = context.applicationContext.getSharedPreferences("easyotp.sent", Context.MODE_PRIVATE)

    private fun key(simKey: String, number: String): String = ReceiverSealer.base64UrlEncode(
        MessageDigest.getInstance("SHA-256").apply {
            update(salt)
            update("$simKey\n${number.trim()}".toByteArray())
        }.digest().copyOf(18),
    )

    /** An SMS or a call arrived from [number] on this SIM. */
    fun heardFrom(simKey: String, number: String, now: Long) {
        val edit = heard.edit().putLong(key(simKey, number), now)
        // Kept small: what is older than the policy looks back is dropped.
        if (heard.all.size > MAX_HEARD) {
            heard.all.forEach { (k, at) -> if (at is Long && now - at > SendPolicy.KNOWN_MILLIS) edit.remove(k) }
        }
        edit.apply()
    }

    fun lastHeardFrom(simKey: String, number: String): Long? =
        heard.getLong(key(simKey, number), -1L).takeIf { it >= 0 }

    fun sentAt(receiverId: String): List<Long> =
        sent.getString(receiverId, "").orEmpty().split(' ').mapNotNull { it.toLongOrNull() }

    /** Counted when the phone is asked to send, whether or not the network then takes it. */
    fun recordSent(receiverId: String, now: Long) {
        val recent = sentAt(receiverId).filter { now - it < 24 * 60 * 60 * 1000L } + now
        sent.edit().putString(receiverId, recent.joinToString(" ")).apply()
    }

    fun forget(receiverId: String) = sent.edit().remove(receiverId).apply()

    private companion object {
        const val MAX_HEARD = 2000
    }
}
