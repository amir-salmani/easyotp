package ir.rhinocloud.easyotp.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract

/**
 * The name this phone's owner gave a number, if they gave it one.
 *
 * A number means little to someone abroad who never saved it on their own
 * device; the phone at home usually knows who it is. Looked up only if the
 * owner switched it on, one number at a time, at the moment a message is
 * sealed. The name travels inside the seal and is kept nowhere else.
 */
object ContactNames {

    fun lookup(context: Context, number: String): String? {
        if (number.isBlank()) return null
        if (context.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) return null
        return runCatching {
            // Android matches the number however it was saved: with or without the country code.
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
            context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0)?.trim()?.take(MAX_NAME)?.takeIf { it.isNotEmpty() } else null
            }
        }.getOrNull()
    }

    private const val MAX_NAME = 60
}
