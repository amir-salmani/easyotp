package ir.rhinocloud.easyotp.dist

import android.content.Context
import android.util.Log
import ir.rhinocloud.easyotp.data.Settings
import ir.rhinocloud.easyotp.net.Bridge
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Fetches newer signed files from the bridges, checks them, and puts them to
 * use (DECISIONS D32). Run from the status alarm, at most every few hours.
 *
 * The bridge list replaces the one in settings. The screens are unpacked
 * beside the app's own and used from the next time the window opens, if they
 * need nothing this build lacks; [Screens] decides that, and falls back.
 */
class DistUpdater(private val context: Context, private val settings: Settings = Settings(context)) {

    private val prefs = context.getSharedPreferences("easyotp.dist", Context.MODE_PRIVATE)

    fun runIfDue(now: Long = System.currentTimeMillis()) {
        if (now - prefs.getLong(KEY_LAST, 0L) < EVERY_MILLIS) return
        prefs.edit().putLong(KEY_LAST, now).apply()
        runCatching { run() }.onFailure { Log.w(TAG, "dist: ${it.javaClass.simpleName}") }
    }

    private fun run() {
        val bridges = settings.bridges
        val index = firstAnswer(bridges, "index")?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return

        val listVersion = index.optJSONObject("bridges")?.optLong("version") ?: 0L
        if (listVersion > settings.bridgesVersion) {
            val list = firstAnswer(bridges, "bridges")?.let { Dist.verify(it, "bridges") }
            val named = list?.takeIf { it.version > settings.bridgesVersion }?.let { Dist.bridgesOf(it.payload) }
            if (list != null && named != null) {
                settings.setBridges(named.map { (id, url) -> Bridge(id, url) }, list.version)
                Log.i(TAG, "dist: bridge list ${list.version}, ${named.size} bridges")
            }
        }

        val ui = index.optJSONObject("host-ui")
        val uiVersion = ui?.optLong("version") ?: 0L
        // Newer than anything this phone has: the APK's own screens count too.
        val have = maxOf(Screens.newest(context), Screens.builtIn(context))
        if (uiVersion > have && (ui?.optInt("core") ?: Int.MAX_VALUE) <= Screens.CORE) {
            val bundle = firstAnswer(bridges, "host-ui")?.let { Dist.verify(it, "host-ui") } ?: return
            if (bundle.core > Screens.CORE || bundle.version <= have) return
            val dir = File(Screens.root(context), "${bundle.version}.part")
            dir.deleteRecursively()
            if (Dist.unpack(bundle.payload, dir) && dir.renameTo(File(Screens.root(context), bundle.version.toString()))) {
                Screens.keepOnly(context, bundle.version)
                Log.i(TAG, "dist: screens ${bundle.version}")
            } else {
                dir.deleteRecursively()
            }
        }
    }

    /** The first bridge that answers with this file. Any bridge will do: the signature is what is trusted. */
    private fun firstAnswer(bridges: List<Bridge>, name: String): String? {
        for (bridge in bridges) {
            val body = runCatching {
                val c = URL("${bridge.baseUrl}/v2/dist/$name").openConnection() as HttpURLConnection
                try {
                    c.connectTimeout = 8_000
                    c.readTimeout = 30_000
                    if (c.responseCode == 200) c.inputStream.use { it.readBytes().decodeToString() } else null
                } finally {
                    c.disconnect()
                }
            }.getOrNull()
            if (body != null) return body
        }
        return null
    }

    private companion object {
        const val TAG = "EasyOTP"
        const val KEY_LAST = "last"
        const val EVERY_MILLIS = 6 * 60 * 60 * 1000L
    }
}
