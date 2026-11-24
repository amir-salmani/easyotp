package ir.rhinocloud.easyotp.net

import ir.rhinocloud.easyotp.data.Receiver
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Waits for one Receiver's commands (DECISIONS D26).
 *
 * A Receiver leaves a command at every bridge. This waits at one bridge at a
 * time, the first that answers, and moves to the next only when that one
 * fails. Waiting at all of them at once would deliver nothing sooner, and a
 * held request is the one thing a bridge on Workers is billed for by the
 * second (BRIDGES). The others are looked at once on every [sweep], so a
 * command a Receiver could only leave at another bridge is still found, late.
 */
class CommandListener(
    private val bridges: List<Bridge>,
    private val receiver: Receiver,
    private val onCommand: (Receiver, Command) -> Unit,
    memory: CommandMemory? = null,
) {
    private val inbox = CommandInbox(receiver.commandKeys, memory)
    private val boxId = ir.rhinocloud.easyotp.pair.PairCodec.boxId(receiver.commandBoxKey)
    private val open = ConcurrentHashMap.newKeySet<HttpURLConnection>()

    @Volatile
    private var running = false

    @Volatile
    private var current = 0

    private var thread: Thread? = null

    fun start() {
        if (running || bridges.isEmpty()) return
        running = true
        thread = Thread({ loop() }, "easyotp-commands").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        // A blocked read ignores an interrupt, so the connection itself is closed.
        open.forEach { runCatching { it.disconnect() } }
    }

    /**
     * Looks once at every bridge this is not already waiting at. A box that
     * holds a command answers at once; an empty one would hold the request
     * for most of a minute, so the look is cut short. Blocks for a few
     * seconds per bridge; call off the main thread.
     */
    fun sweep() {
        val waitingAt = current
        bridges.forEachIndexed { index, bridge ->
            if (running && index != waitingAt) collect(bridge, SWEEP_TIMEOUT_MILLIS)
        }
    }

    private fun loop() {
        var failures = 0
        try {
            while (running) {
                val asked = System.nanoTime()
                val got = collect(bridges[current], READ_TIMEOUT_MILLIS)
                if (got == null) {
                    failures++
                    current = (current + 1) % bridges.size
                    // Once every bridge has failed in a row, wait longer each time round.
                    val rounds = failures / bridges.size
                    Thread.sleep(minOf(MAX_BACKOFF_MILLIS, RETRY_MILLIS shl minOf(rounds, 5)))
                    continue
                }
                failures = 0
                val tookMillis = (System.nanoTime() - asked) / 1_000_000
                // A bridge that answers at once with nothing is not asked again straight away.
                if (got == 0 && tookMillis < MIN_POLL_MILLIS) Thread.sleep(MIN_POLL_MILLIS - tookMillis)
            }
        } catch (e: InterruptedException) {
            // Stopped.
        }
    }

    /**
     * How many messages the bridge handed over, or null if it could not be
     * asked or would not take the acknowledgement. The second matters: a
     * bridge that keeps what it was told to drop hands it straight back, and
     * without a pause that is a loop that never sleeps.
     */
    private fun collect(bridge: Bridge, readTimeoutMillis: Int): Int? {
        val url = "${bridge.baseUrl}/v2/box/$boxId"
        val body = request(url, readTimeoutMillis, null) ?: return null
        val ids = mutableListOf<String>()
        try {
            val messages = JSONObject(body).getJSONArray("messages")
            for (i in 0 until messages.length()) {
                val m = messages.getJSONObject(i)
                val id = m.getString("id")
                ids += id
                inbox.accept(id, m.optString("enc"), m.optString("ct"))?.let { onCommand(receiver, it) }
            }
        } catch (e: Exception) {
            return null
        }
        // Everything collected is acknowledged, readable or not, so junk left
        // in the box by someone who learned its id does not stay there.
        if (ids.isNotEmpty()) {
            request("$url/ack", POST_TIMEOUT_MILLIS, JSONObject().put("ids", JSONArray(ids)).toString()) ?: return null
        }
        return ids.size
    }

    private fun request(url: String, readTimeoutMillis: Int, post: String?): String? {
        if (!running) return null
        val connection = URL(url).openConnection() as HttpURLConnection
        open += connection
        return try {
            connection.connectTimeout = CONNECT_TIMEOUT_MILLIS
            connection.readTimeout = readTimeoutMillis
            connection.setRequestProperty("authorization", "Bearer ${receiver.commandBoxKey}")
            connection.setRequestProperty("accept", "application/json")
            if (post != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                connection.outputStream.use { it.write(post.toByteArray()) }
            }
            if (connection.responseCode !in 200..299) return null
            connection.inputStream.use { it.readBytes().decodeToString() }
        } catch (e: Exception) {
            null
        } finally {
            open -= connection
            connection.disconnect()
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT_MILLIS = 8_000
        const val POST_TIMEOUT_MILLIS = 15_000

        /** Longer than a bridge's longest hold. */
        const val READ_TIMEOUT_MILLIS = 75_000
        const val SWEEP_TIMEOUT_MILLIS = 5_000
        const val RETRY_MILLIS = 2_000L
        const val MAX_BACKOFF_MILLIS = 60_000L
        const val MIN_POLL_MILLIS = 1_000L
    }
}
