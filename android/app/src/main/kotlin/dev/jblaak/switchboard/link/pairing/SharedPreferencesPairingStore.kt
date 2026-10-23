package dev.jblaak.switchboard.link.pairing

import android.content.SharedPreferences
import dev.jblaak.switchboard.link.discovery.MacAddress

/** Keeps the pairing in the app's private preferences, which backups leave out (`allowBackup="false"`). */
class SharedPreferencesPairingStore(private val preferences: SharedPreferences) : PairingStore {

    override fun loadOrNull(): StoredPairing? {
        return StoredPairing(
            macFingerprint = preferences.getString(FINGERPRINT, null) ?: return null,
            deviceId = preferences.getString(DEVICE_ID, null) ?: return null,
            macName = preferences.getString(MAC_NAME, null) ?: return null,
            lastAddress = MacAddress(
                host = preferences.getString(HOST, null) ?: return null,
                port = preferences.getInt(PORT, 0).takeIf { it in 1..65535 } ?: return null,
            ),
        )
    }

    override fun save(pairing: StoredPairing) {
        preferences.edit()
            .putString(FINGERPRINT, pairing.macFingerprint)
            .putString(DEVICE_ID, pairing.deviceId)
            .putString(MAC_NAME, pairing.macName)
            .putString(HOST, pairing.lastAddress.host)
            .putInt(PORT, pairing.lastAddress.port)
            .apply()
    }

    override fun clear() {
        preferences.edit().clear().apply()
    }

    private companion object {
        const val FINGERPRINT = "macFingerprint"
        const val DEVICE_ID = "deviceId"
        const val MAC_NAME = "macName"
        const val HOST = "host"
        const val PORT = "port"
    }
}
