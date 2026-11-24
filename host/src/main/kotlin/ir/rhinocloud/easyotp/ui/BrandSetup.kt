package ir.rhinocloud.easyotp.ui

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * The extra setting some phone makers hide their app-killer behind.
 *
 * Android's own battery exemption is asked for in setup. On top of it,
 * Xiaomi, Huawei, Oppo, Vivo and others stop apps that are not on a list of
 * their own, under a name of their own ("autostart", "startup manager",
 * "never sleeping apps"), on a screen of their own. A relative following
 * instructions over a phone call will not find it. So the Host knows where it
 * is on each maker's phones, and opens it.
 *
 * The screens are not public API and move between versions, so each maker
 * has several addresses, tried in order, and the app's own settings page is
 * the last resort. Android cannot report whether the person then switched
 * the setting on, so the screens ask them.
 */
object BrandSetup {

    /** A maker this knows, by the name its screens use, or null when Android's own setting is enough. */
    fun brand(): String? {
        val maker = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        return when {
            listOf("xiaomi", "redmi", "poco").any { it in maker } -> "xiaomi"
            listOf("huawei", "honor").any { it in maker } -> "huawei"
            listOf("oppo", "realme", "oneplus").any { it in maker } -> "oppo"
            listOf("vivo", "iqoo").any { it in maker } -> "vivo"
            "samsung" in maker -> "samsung"
            "asus" in maker -> "asus"
            else -> null
        }
    }

    private val SCREENS = mapOf(
        "xiaomi" to listOf(
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.miui.securitycenter" to "com.miui.powercenter.PowerSettings",
        ),
        "huawei" to listOf(
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
            "com.hihonor.systemmanager" to "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
        ),
        "oppo" to listOf(
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
        ),
        "vivo" to listOf(
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
        ),
        "samsung" to listOf(
            "com.samsung.android.lool" to "com.samsung.android.sm.battery.ui.BatteryActivity",
            "com.samsung.android.sm" to "com.samsung.android.sm.ui.battery.BatteryActivity",
        ),
        "asus" to listOf(
            "com.asus.mobilemanager" to "com.asus.mobilemanager.autostart.AutoStartActivity",
        ),
    )

    /** Opens the maker's screen, or the app's own settings when none of its addresses answers. */
    fun open(activity: Activity, fallback: Intent) {
        val brand = brand()
        for ((pkg, cls) in SCREENS[brand].orEmpty()) {
            val opened = runCatching {
                activity.startActivity(Intent().setComponent(ComponentName(pkg, cls)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }.isSuccess
            if (opened) return
        }
        Log.i("EasyOTP", "no maker screen for $brand; app settings instead")
        runCatching { activity.startActivity(fallback) }
    }
}
