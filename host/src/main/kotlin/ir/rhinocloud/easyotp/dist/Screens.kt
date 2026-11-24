package ir.rhinocloud.easyotp.dist

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * Which copy of the Host's screens to show: the one built into the APK, or a
 * newer one fetched and checked by [DistUpdater] (DECISIONS D19, D32).
 *
 * A fetched copy is used only if it is newer than the built-in one and has
 * not failed before. It has to say it drew, through `HostApi.ready`, within a
 * few seconds of opening; one that does not is marked failed, and the window
 * opens again with the built-in screens. A bad bundle costs one blank moment,
 * never a phone nobody can set up.
 */
object Screens {

    /** The version of the interface between the screens and this build; see CORE in native.ts. */
    const val CORE = 1

    fun root(context: Context) = File(context.filesDir, "ui")

    /** The newest fetched copy's version, or 0. */
    fun newest(context: Context): Long =
        root(context).listFiles()?.mapNotNull { it.name.toLongOrNull() }?.maxOrNull() ?: 0L

    fun builtIn(context: Context): Long = runCatching {
        JSONObject(context.assets.open("ui/version.json").use { it.readBytes().decodeToString() }).getLong("version")
    }.getOrDefault(0L)

    private fun prefs(context: Context) = context.getSharedPreferences("easyotp.screens", Context.MODE_PRIVATE)

    /** The directory of the fetched copy to show, or null for the built-in screens. */
    fun fetched(context: Context): File? {
        val version = newest(context)
        if (version <= builtIn(context) || prefs(context).getLong("failed", 0L) == version) return null
        return File(root(context), version.toString()).takeIf { File(it, "host.html").isFile }
    }

    /** The fetched copy did not draw. It is not tried again. */
    fun failed(context: Context, version: Long) = prefs(context).edit().putLong("failed", version).apply()

    fun keepOnly(context: Context, version: Long) {
        root(context).listFiles()?.filter { it.name != version.toString() }?.forEach { it.deleteRecursively() }
    }
}
