package ir.rhinocloud.easyotp.service

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager

/** What the phone says about itself, for a status report. Anything it will not say is null. */
object DeviceState {

    data class Battery(val percent: Int?, val charging: Boolean?)

    fun battery(context: Context): Battery {
        // A sticky broadcast: registering with no receiver returns the last one.
        val intent = runCatching {
            context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull() ?: return Battery(null, null)
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        return Battery(
            percent = if (level >= 0 && scale > 0) (level * 100 / scale).coerceIn(0, 100) else null,
            charging = when (status) {
                BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
                BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
                else -> null
            },
        )
    }

    /** "wifi", "cell", "none", or null if the phone will not say. */
    fun network(context: Context): String? = runCatching {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return null
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork ?: return "none") ?: return "none"
        when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cell"
            // Something else carries traffic, a VPN for instance. The report has no word for it.
            else -> null
        }
    }.getOrNull()
}
