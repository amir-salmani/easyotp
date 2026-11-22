package ir.rhinocloud.easyotp.net

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Callable
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
 * enough for the message to count as sent.
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
     */
    fun deposit(boxId: String, messageId: String, sealed: SealedEnvelope): DepositResult {
        // Shape must match bridge/src/core.ts.
        val body = JSONObject()
            .put("v", 2)
            .put("id", messageId)
            .put("enc", ReceiverSealer.base64UrlEncode(sealed.enc))
            .put("ct", ReceiverSealer.base64UrlEncode(sealed.ciphertext))
            .toString()
            .toByteArray()

        val tasks = health.all().map { bridge -> Callable { post(bridge, boxId, body) } }
        val attempts = try {
            pool.invokeAll(tasks, TOTAL_TIMEOUT_SECONDS, TimeUnit.SECONDS).map { future ->
                // A task still running at the deadline comes back cancelled.
                if (future.isCancelled) Attempt.Failed else runCatching { future.get() }.getOrDefault(Attempt.Failed)
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return DepositResult.Unreachable
        }

        val accepted = attempts.filterIsInstance<Attempt.Accepted>().map { it.bridgeId }
        if (accepted.isNotEmpty()) return DepositResult.Accepted(accepted)
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
                // A 5xx is the bridge failing, and that includes a bridge that
                // is full (507). A 4xx is the message being refused. Only the
                // former counts against the bridge: otherwise one malformed
                // message would mark every healthy bridge as broken.
                val bridgeFailure = code >= 500
                health.record(bridge.id, success = !bridgeFailure, latencyMillis = elapsed, now = clock())
                if (bridgeFailure) {
                    Attempt.Failed
                } else {
                    val payload = connection.errorStream?.use { it.readBytes().decodeToString() }.orEmpty()
                    Attempt.Refused(reasonOf(payload, code))
                }
            }
        } catch (e: Exception) {
            health.record(bridge.id, success = false, latencyMillis = clock() - started, now = clock())
            Attempt.Failed
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * Extracts the bridge's machine-readable reason code.
     *
     * Only the known `error` field, never free text: this value is written to
     * the outbox and to the log (THREAT-MODEL rule 1).
     */
    private fun reasonOf(payload: String, code: Int): String =
        runCatching { JSONObject(payload).optString("error").takeIf { it.matches(REASON_SHAPE) } }
            .getOrNull() ?: "http_$code"

    companion object {
        /**
         * Short by design. This runs on a phone that is either reachable quickly
         * or blocked outright; a long timeout only delays the retry past the
         * life of the code being delivered.
         */
        private const val CONNECT_TIMEOUT_MILLIS = 8_000
        private const val READ_TIMEOUT_MILLIS = 15_000
        private const val TOTAL_TIMEOUT_SECONDS = 25L
        private val REASON_SHAPE = Regex("[a-z0-9_]{1,40}")
    }
}
