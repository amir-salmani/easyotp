package ir.rhinocloud.easyotp.pair

import ir.rhinocloud.easyotp.net.Hpke
import ir.rhinocloud.easyotp.net.ReceiverSealer
import org.json.JSONObject
import java.security.SecureRandom
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class SlotMessage(val seq: Long, val from: String, val data: String)

data class SlotView(val epoch: Long, val messages: List<SlotMessage>)

/** How pairing messages reach a bridge. Separate so the steps can be tested without a network. */
interface SlotTransport {
    /** True once the bridge has taken it. */
    fun post(bridge: String, slotId: String, body: String): Boolean

    /** What the slot holds after [after], or null if the bridge could not be asked. May wait. */
    fun read(bridge: String, slotId: String, after: Long): SlotView?

    /** Cuts anything in flight. Called when the person gives up. */
    fun cancel() {}
}

class PairingFailed(val reason: String) : Exception(reason) {
    companion object {
        const val UNREACHABLE = "unreachable"
        const val TIMEOUT = "timeout"
        const val CANCELLED = "cancelled"
    }
}

/** What a finished exchange gives the Host. Nothing is stored until the person confirms the picture. */
class PairedReceiver(
    val label: String,
    val publicKey: String,
    val boxId: String,
    /** The bytes the picture is drawn from; see receiver/src/pictures.ts. */
    val sas: ByteArray,
)

/**
 * The Host's side of a pairing (DECISIONS D18, D24). The reasoning for the
 * order of the three messages is at the top of receiver/src/pairing.ts, and
 * `pairAsHost` there is this class's twin.
 *
 *   1. commit   SHA-256(nonce), and a public key made for this one pairing
 *   2. offer    from the Receiver, sealed to that key
 *   3. reveal   the nonce, this phone's name, and where to send commands
 */
class HostPairing(
    private val bridges: List<String>,
    private val transport: SlotTransport,
    private val code: String,
    label: String,
    /** The command channel made for this Receiver (DECISIONS D26). */
    private val commandPublicKey: String,
    private val commandBoxId: String,
    private val timeoutMillis: Long = 10 * 60 * 1000L,
    private val random: SecureRandom = SecureRandom(),
) {
    private val label = PairCodec.cleanLabel(label)
    private val slotId = PairCodec.slotId(code)
    private val cancelled = AtomicBoolean(false)
    private val pool: ExecutorService = Executors.newCachedThreadPool()

    fun cancel() {
        cancelled.set(true)
        transport.cancel()
        pool.shutdownNow()
    }

    /** Blocks until a Receiver has made an offer and been answered. */
    fun run(): PairedReceiver {
        try {
            val nonce = PairCodec.b64(ByteArray(32).also(random::nextBytes))
            // Made for this one pairing and dropped after it.
            val oneTime = Hpke.newKeyPair()
            send(PairCodec.commit(PairCodec.commitment(nonce), oneTime.publicKey))

            val offers = LinkedBlockingQueue<Pair<String, String>>()
            bridges.forEach { bridge -> pool.execute { listen(bridge, offers) } }

            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
            while (true) {
                if (cancelled.get()) throw PairingFailed(PairingFailed.CANCELLED)
                val left = deadline - System.nanoTime()
                if (left <= 0) throw PairingFailed(PairingFailed.TIMEOUT)
                val (enc, ct) = offers.poll(minOf(left, TimeUnit.SECONDS.toNanos(1)), TimeUnit.NANOSECONDS) ?: continue
                // The first offer that opens. Anything else in the slot is someone else's noise.
                val body = Hpke.open(oneTime, enc, ct)?.let(PairCodec::offerBody) ?: continue

                // Only now, with the offer fixed, is the nonce given away.
                val channel = ReceiverSealer.fromBase64Url(body.publicKey).seal(
                    PairCodec.utf8(JSONObject().put("pk", commandPublicKey).put("box", commandBoxId).toString()),
                )
                // To every bridge, not just the first: the Receiver may be able
                // to reach only one of them, and this is the last message.
                send(
                    PairCodec.reveal(
                        nonce, label, PairCodec.offerId(enc, ct),
                        PairCodec.b64(channel.enc), PairCodec.b64(channel.ciphertext),
                    ),
                    settle = true,
                )
                return PairedReceiver(
                    label = body.label,
                    publicKey = body.publicKey,
                    boxId = body.boxId,
                    sas = PairCodec.sas(
                        code, nonce, body.nonce, body.publicKey, body.boxId, oneTime.publicKey, label, body.label,
                    ),
                )
            }
        } catch (e: InterruptedException) {
            throw PairingFailed(PairingFailed.CANCELLED)
        } finally {
            // The slot is no longer read. Whatever is still waiting at a bridge is cut.
            cancelled.set(true)
            transport.cancel()
            pool.shutdownNow()
        }
    }

    /**
     * Posts to every bridge and returns as soon as one has taken it.
     *
     * @param settle wait a little longer for the others as well, because
     *   whatever is still in flight is cut when the pairing ends.
     */
    private fun send(message: JSONObject, settle: Boolean = false) {
        if (cancelled.get()) throw PairingFailed(PairingFailed.CANCELLED)
        val body = JSONObject().put("v", 2).put("from", "host").put("data", PairCodec.encode(message)).toString()
        val done = ExecutorCompletionService<Boolean>(pool)
        bridges.forEach { bridge -> done.submit { transport.post(bridge, slotId, body) } }
        var deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(POST_TIMEOUT_SECONDS)
        var taken = false
        for (i in bridges.indices) {
            val finished = done.poll(deadline - System.nanoTime(), TimeUnit.NANOSECONDS) ?: break
            if (!runCatching { finished.get() }.getOrDefault(false)) continue
            if (!settle) return
            if (!taken) deadline = minOf(deadline, System.nanoTime() + TimeUnit.SECONDS.toNanos(SETTLE_SECONDS))
            taken = true
        }
        if (taken) return
        throw PairingFailed(if (cancelled.get()) PairingFailed.CANCELLED else PairingFailed.UNREACHABLE)
    }

    /** Reads one bridge's copy of the slot until the pairing ends, handing over every offer it sees. */
    private fun listen(bridge: String, offers: LinkedBlockingQueue<Pair<String, String>>) {
        var cursor = 0L
        var epoch = 0L
        try {
            while (!cancelled.get()) {
                val asked = System.nanoTime()
                val view = runCatching { transport.read(bridge, slotId, cursor) }.getOrNull()
                if (view == null) {
                    // A bridge that is down must not end the pairing; the other may be up.
                    Thread.sleep(RETRY_MILLIS)
                    continue
                }
                if (view.epoch != epoch) {
                    // The slot was replaced: it expired, or the bridge restarted.
                    // Its messages are numbered from 1 again, so this side starts over too.
                    epoch = view.epoch
                    if (cursor > 0) {
                        cursor = 0
                        continue
                    }
                }
                for (m in view.messages) {
                    cursor = maxOf(cursor, m.seq)
                    if (m.from == "receiver") PairCodec.offerOf(m.data)?.let(offers::add)
                }
                val took = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - asked)
                // A bridge that answers at once with nothing is not asked again straight away.
                if (view.messages.isEmpty() && took < MIN_POLL_MILLIS) Thread.sleep(MIN_POLL_MILLIS - took)
            }
        } catch (e: InterruptedException) {
            // The pairing ended.
        }
    }

    companion object {
        private const val POST_TIMEOUT_SECONDS = 15L

        /** How long the last message waits for the slower bridges once one has it. */
        private const val SETTLE_SECONDS = 5L
        private const val RETRY_MILLIS = 1500L
        private const val MIN_POLL_MILLIS = 1000L

        /** Eight digits, for the Host to show. */
        fun newCode(random: SecureRandom = SecureRandom()): String =
            random.nextInt(100_000_000).toString().padStart(8, '0')
    }
}
