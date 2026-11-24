package ir.rhinocloud.easyotp.pair

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/** Pairing slots over HTTPS, with the platform client (DECISIONS D14). */
class HttpSlotTransport : SlotTransport {

    private val open = ConcurrentHashMap.newKeySet<HttpURLConnection>()

    @Volatile
    private var cancelled = false

    override fun post(bridge: String, slotId: String, body: String): Boolean = request("$bridge/v2/pair/$slotId", POST_TIMEOUT) {
        requestMethod = "POST"
        doOutput = true
        setRequestProperty("content-type", "application/json")
        outputStream.use { it.write(body.toByteArray()) }
        responseCode in 200..299
    } ?: false

    override fun read(bridge: String, slotId: String, after: Long): SlotView? =
        request("$bridge/v2/pair/$slotId?after=$after", READ_TIMEOUT) {
            if (responseCode !in 200..299) return@request null
            val json = JSONObject(inputStream.use { it.readBytes().decodeToString() })
            val array = json.getJSONArray("messages")
            SlotView(
                epoch = json.optLong("epoch"),
                messages = (0 until array.length()).map {
                    val m = array.getJSONObject(it)
                    SlotMessage(m.getLong("seq"), m.getString("from"), m.getString("data"))
                },
            )
        }

    /** A blocked read ignores an interrupt, so the connection itself is closed. */
    override fun cancel() {
        cancelled = true
        open.forEach { runCatching { it.disconnect() } }
    }

    private fun <T> request(url: String, readTimeoutMillis: Int, block: HttpURLConnection.() -> T?): T? {
        if (cancelled) return null
        val connection = URL(url).openConnection() as HttpURLConnection
        open += connection
        return try {
            connection.connectTimeout = CONNECT_TIMEOUT
            connection.readTimeout = readTimeoutMillis
            connection.setRequestProperty("accept", "application/json")
            connection.block()
        } catch (e: Exception) {
            null
        } finally {
            open -= connection
            connection.disconnect()
        }
    }

    private companion object {
        const val CONNECT_TIMEOUT = 8_000
        const val POST_TIMEOUT = 15_000

        /** Longer than a bridge's longest hold. */
        const val READ_TIMEOUT = 70_000
    }
}
