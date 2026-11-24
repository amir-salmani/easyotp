package ir.rhinocloud.easyotp.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager

/**
 * Resolves an incoming message to the SIM that received it.
 *
 * A message routed under the wrong SIM goes to the wrong person, silently, and
 * on a product that carries a spouse's bank codes that is the worst failure
 * there is. So the key must be the SIM itself and never the slot it sits in,
 * which changes with a swap or a dual-SIM toggle.
 *
 * The ICCID is that key where Android reveals it. From Android 10 an ordinary
 * app is given an empty string instead, and then the key is the subscription
 * id, which the phone assigns to a SIM when it first sees it. See [routingKey].
 *
 * Iranian carriers generally report an empty MSISDN, so the phone number is not
 * available to identify a line. The owner labels each SIM once and the label is
 * bound to the key.
 */
data class SimIdentity(
    /** The routing key. Named for what it usually was; see [SimRegistry.routingKey]. */
    val iccid: String,
    val subscriptionId: Int,
    val slotIndex: Int,
    /** Carrier-reported, for display only. Never used for routing. */
    val carrierName: String?,
    /** Usually null on Iranian carriers. Display only. */
    val number: String?,
)

class SimRegistry(private val context: Context) {

    private fun hasPhoneStatePermission(): Boolean =
        context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) ==
            PackageManager.PERMISSION_GRANTED

    /** Every SIM currently active in the device. Empty if permission is not granted. */
    fun activeSims(): List<SimIdentity> {
        if (!hasPhoneStatePermission()) return emptyList()
        val sm = context.getSystemService(SubscriptionManager::class.java) ?: return emptyList()

        @Suppress("MissingPermission") // guarded above
        val active = sm.activeSubscriptionInfoList ?: return emptyList()

        return active.map { info ->
            SimIdentity(
                iccid = routingKey(info.iccId, info.subscriptionId),
                subscriptionId = info.subscriptionId,
                slotIndex = info.simSlotIndex,
                carrierName = info.carrierName?.toString(),
                number = info.number?.takeIf { it.isNotBlank() },
            )
        }
    }

    /**
     * Maps the subscription id carried on an SMS_RECEIVED intent to a SIM.
     *
     * Returns null when the subscription cannot be resolved -- a message that
     * cannot be attributed must not be guessed at. Delivering it under the wrong
     * SIM's routing rules would send it to the wrong person.
     */
    fun resolve(subscriptionId: Int): SimIdentity? {
        if (subscriptionId == INVALID_SUBSCRIPTION_ID) return null
        return activeSims().firstOrNull { it.subscriptionId == subscriptionId }
    }

    /**
     * The SIM that is ringing now, if exactly one is.
     *
     * The broadcast that says the phone is ringing does not say on which SIM:
     * seen on a two-SIM phone with Android 16, where it carried the number and
     * nothing else. Each SIM can be asked for its own call state, though, and
     * that is asked here.
     */
    @Suppress("MissingPermission") // guarded on the first line
    fun ringingSim(): SimIdentity? {
        if (!hasPhoneStatePermission()) return null
        val telephony = context.getSystemService(TelephonyManager::class.java) ?: return null
        return activeSims().filter { sim ->
            runCatching {
                val own = telephony.createForSubscriptionId(sim.subscriptionId)
                @Suppress("DEPRECATION") // On an instance made for one SIM, this is that SIM's state on every version.
                val state = if (Build.VERSION.SDK_INT >= 31) own.callStateForSubscription else own.callState
                state == TelephonyManager.CALL_STATE_RINGING
            }.getOrDefault(false)
        }.singleOrNull()
    }

    /**
     * What a Receiver sees a SIM called: the carrier's name, and the slot when
     * the phone holds more than one, since two lines from one carrier are
     * common. Falls back to something readable when the SIM is gone or the
     * permission is.
     */
    fun labelFor(routingKey: String): String {
        val sims = activeSims()
        val sim = sims.firstOrNull { it.iccid == routingKey } ?: return "SIM"
        val slot = "SIM ${sim.slotIndex + 1}"
        val carrier = sim.carrierName?.trim().orEmpty()
        return when {
            carrier.isEmpty() -> slot
            sims.size > 1 -> "$carrier · $slot"
            else -> carrier
        }
    }

    companion object {
        /**
         * The key a SIM's route is stored under.
         *
         * Never blank: two SIMs that both report an empty ICCID would share one
         * route, and one person's codes would be sealed to the other's Receiver.
         *
         * Unverified on a phone: that a subscription id stays with its SIM
         * across reboots and re-insertion on the brands this must run on.
         */
        fun routingKey(iccId: String?, subscriptionId: Int): String =
            iccId?.takeIf { it.isNotBlank() } ?: "sub:$subscriptionId"

        val INVALID_SUBSCRIPTION_ID: Int
            get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                SubscriptionManager.INVALID_SUBSCRIPTION_ID
            } else {
                -1
            }
    }
}
