package ir.rhinocloud.easyotp.net

/** One bridge: an interchangeable relay that cannot read what it carries (DECISIONS D17). */
data class Bridge(val id: String, val baseUrl: String)

/**
 * What is known about each bridge, from the outcomes of real deposits.
 *
 * Every message goes to every bridge, so this does not choose between them. It
 * exists so the app can say which bridges are working: on a phone nobody is
 * watching, "bridge 1 has failed for two days" is the only warning there is.
 *
 * Pure: no I/O and no clock of its own, so the behaviour can be tested without
 * a network.
 */
class BridgeHealth(bridges: List<Bridge>) {
    init {
        require(bridges.isNotEmpty()) { "at least one bridge is required" }
    }

    private val health = bridges.associate { it.id to Health(it) }

    private class Health(val bridge: Bridge) {
        /** Starts optimistic so an untried bridge is not reported as broken. */
        var successRate: Double = 1.0
        var latencyMillis: Double = DEFAULT_LATENCY_MILLIS
        var lastAttemptAt: Long = 0
        var attempts: Long = 0
    }

    /** Deposits run in parallel, one thread per bridge, so this is synchronised. */
    @Synchronized
    fun record(bridgeId: String, success: Boolean, latencyMillis: Long, now: Long) {
        val h = health[bridgeId] ?: return
        h.successRate = ewma(h.successRate, if (success) 1.0 else 0.0)
        // Only successes carry timing information. A failure's latency is a
        // timeout, and folding those in would make a dead bridge look merely
        // slow rather than broken.
        if (success) h.latencyMillis = ewma(h.latencyMillis, latencyMillis.toDouble())
        h.lastAttemptAt = now
        h.attempts++
    }

    /** Every bridge, in the order given. Nothing is ever dropped from this list. */
    fun all(): List<Bridge> = health.values.map { it.bridge }

    /** For the status screen. Never includes anything about a message. */
    @Synchronized
    fun snapshot(): List<BridgeStatus> =
        health.values.map {
            BridgeStatus(
                id = it.bridge.id,
                successRate = it.successRate,
                latencyMillis = it.latencyMillis.toLong(),
                attempts = it.attempts,
                lastAttemptAt = it.lastAttemptAt,
            )
        }

    private fun ewma(current: Double, sample: Double): Double =
        current * (1 - ALPHA) + sample * ALPHA

    companion object {
        /**
         * Weight of the newest observation. High enough that a blocked bridge
         * shows as failing within a handful of attempts, since Iranian
         * filtering changes on the scale of minutes rather than days.
         */
        const val ALPHA = 0.3
        const val HEALTHY_THRESHOLD = 0.5
        private const val DEFAULT_LATENCY_MILLIS = 1000.0
    }
}

data class BridgeStatus(
    val id: String,
    val successRate: Double,
    val latencyMillis: Long,
    val attempts: Long,
    val lastAttemptAt: Long,
) {
    val healthy: Boolean get() = successRate >= BridgeHealth.HEALTHY_THRESHOLD
}
