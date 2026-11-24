package ir.rhinocloud.easyotp.net

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** What the caller needs to decide whether to retry. Never carries a message. */
sealed class DepositResult {
    /** At least one bridge is holding the message for the Receiver. */
    data class Accepted(val bridgeIds: List<String>) : DepositResult()

    /** A bridge refused the message itself. Sending the same bytes again will not help. */
    data class Rejected(val reason: String) : DepositResult()

    /** No bridge answered. Worth retrying when the network returns. */
    data object Unreachable : DepositResult()
}

/**
 * Leaves a sealed message at every bridge.
 *
 * All bridges at once, not one after another: a code is worthless after about a
 * minute, a deposit is under two kilobytes, and the Receiver shows each message
 * once however many bridges deliver it (DECISIONS D17). One bridge accepting is
 * enough for the message to count as sent, and once one has, the rest get only a
 * moment more: a filtered bridge that hangs must not hold every message behind
 * it for the length of its timeout.
 *
 * HTTP is the platform client rather than OkHttp; the reasoning is DECISIONS D14.
 */
class BridgeClient(
    private val health: BridgeHealth,
    private val pool: ExecutorService = Executors.newCachedThreadPool(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val open: (String) -> HttpURLConnection = { URL(it).openConnection() as HttpURLConnection },
) {

    private sealed class Attempt {
        data class Accepted(val bridgeId: String) : Attempt()
        data class Refused(val reason: String) : Attempt()
        data object Failed : Attempt()
    }

    /**
     * @param boxId the Receiver's box, learned at pairing.
     * @param messageId the same id that is inside the seal; see [Payload.wireId].
     * @param tag a bridge keeps only the newest message with a given tag. Used
     *   for status reports, which would otherwise fill the box (DECISIONS D26).
     */
    fun deposit(boxId: String, messageId: String, sealed: SealedEnvelope, tag: String? = null): DepositResult {
        // Shape must match bridge/src/core.ts.
        val body = JSONObject()
            .put("v", 2)
            .put("id", messageId)
            .put("enc", ReceiverSealer.base64UrlEncode(sealed.enc))
            .put("ct", ReceiverSealer.base64UrlEncode(sealed.ciphertext))
            .apply { if (tag != null) put("tag", tag) }
            .toString()
            .toByteArray()

        val bridges = health.all()
        val completion = ExecutorCompletionService<Attempt>(pool)
        bridges.forEach { bridge -> completion.submit(Callable { post(bridge, boxId, body) }) }

        val attempts = mutableListOf<Attempt>()
        var deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(TOTAL_TIMEOUT_SECONDS)
        try {
            while (attempts.size < bridges.size) {
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) break
                val finished = completion.poll(remaining, TimeUnit.NANOSECONDS) ?: break
                val attempt = runCatching { finished.get() }.getOrDefault(Attempt.Failed)
                attempts += attempt
                if (attempt is Attempt.Accepted) {
                    // Posts still running are left to finish on their own
                    // threads, and still record what they learn about a bridge.
                    val grace = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(GRACE_AFTER_ACCEPT_MILLIS)
                    deadline = minOf(deadline, grace)
                }
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return DepositResult.Unreachable
        }

        val accepted = attempts.filterIsInstance<Attempt.Accepted>().map { it.bridgeId }.toSet()
        if (accepted.isNotEmpty()) {
            return DepositResult.Accepted(bridges.map { it.id }.filter { it in accepted })
        }
        // A refusal is a bridge's verdict on the message, which every bridge
        // would repeat. It outranks a timeout, because it means stop retrying.
        val refused = attempts.filterIsInstance<Attempt.Refused>().firstOrNull()
        return if (refused != null) DepositResult.Rejected(refused.reason) else DepositResult.Unreachable
    }

    private fun post(bridge: Bridge, boxId: String, body: ByteArray): Attempt {
        val started = clock()
        var connection: HttpURLConnection? = null
        return try {
            connection = open("${bridge.baseUrl}/v2/box/$boxId").apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MILLIS
                readTimeout = READ_TIMEOUT_MILLIS
                doOutput = true
                setRequestProperty("content-type", "application/json")
                setRequestProperty("accept", "application/json")
            }
            connection.outputStream.use { it.write(body) }

            val code = connection.responseCode
            val elapsed = clock() - started

            if (code in 200..299) {
                health.record(bridge.id, success = true, latencyMillis = elapsed, now = clock())
                Attempt.Accepted(bridge.id)
            } else {
                // Only a refusal the bridge itself wrote is the message's
                // fault. Everything else is the bridge failing: a 5xx, a full
                // bridge (507), and also a 403 or 404 from whatever stands in
                // front of it. Counting those as healthy would hide a bridge
                // that has delivered nothing for days.
                val refusal = if (code in 400..499) {
                    refusalOf(connection.errorStream?.use { it.readBytes().decodeToString() }.orEmpty())
                } else {
                    null
                }
                health.record(bridge.id, success = refusal != null, latencyMillis = elapsed, now = clock())
                if (refusal != null) Attempt.Refused(refusal) else Attempt.Failed
            }
        } catch (e: Exception) {
            health.record(bridge.id, success = false, latencyMillis = clock() - started, now = clock())
            Attempt.Failed
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * The bridge's own reason for refusing a message, or null if the answer
     * did not come from the bridge.
     *
     * Only a code from the known list, never free text: this value is written
     * to the outbox and to the log (THREAT-MODEL rule 1).
     */
    private fun refusalOf(payload: String): String? =
        runCatching { JSONObject(payload).optString("error").takeIf { it in MESSAGE_REFUSALS } }.getOrNull()

    companion object {
        /**
         * Short by design. This runs on a phone that is either reachable quickly
         * or blocked outright; a long timeout only delays the retry past the
         * life of the code being delivered.
         */
        private const val CONNECT_TIMEOUT_MILLIS = 8_000
        private const val READ_TIMEOUT_MILLIS = 15_000
        private const val TOTAL_TIMEOUT_SECONDS = 25L
        private const val GRACE_AFTER_ACCEPT_MILLIS = 1_500L

        /** What bridge/src/core.ts answers when the message itself is at fault. */
        private val MESSAGE_REFUSALS = setOf("malformed", "too_large", "unsupported_version")
    }
}
