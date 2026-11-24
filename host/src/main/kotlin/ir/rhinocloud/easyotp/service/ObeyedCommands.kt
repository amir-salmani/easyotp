package ir.rhinocloud.easyotp.service

import android.content.Context
import ir.rhinocloud.easyotp.net.CommandMemory

/**
 * Remembers, across restarts, which of one Receiver's commands this phone has
 * already obeyed. Only ids: random values that say nothing about anyone.
 */
class ObeyedCommands(context: Context, private val receiverId: String) : CommandMemory {

    private val prefs = context.applicationContext.getSharedPreferences("easyotp.commands", Context.MODE_PRIVATE)

    override fun load(): List<String> =
        prefs.getString(receiverId, "").orEmpty().split(' ').filter { it.isNotEmpty() }

    override fun save(ids: List<String>) {
        prefs.edit().putString(receiverId, ids.joinToString(" ")).apply()
    }

    companion object {
        /** The Receiver was removed; so is what was remembered about it. */
        fun forget(context: Context, receiverId: String) {
            context.applicationContext.getSharedPreferences("easyotp.commands", Context.MODE_PRIVATE)
                .edit().remove(receiverId).apply()
        }
    }
}
