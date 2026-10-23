package dev.jblaak.switchboard.link.pairing

import dev.jblaak.switchboard.link.discovery.MacAddress

/** What the phone keeps of a pairing besides its key: who the Mac is and where it was last reached. */
data class StoredPairing(
    /** The Mac's pinned certificate fingerprint, from the pairing QR code. */
    val macFingerprint: String,
    val deviceId: String,
    val macName: String,
    /** The last address a connection worked on: the fallback when Bonjour finds nothing. */
    val lastAddress: MacAddress,
)

interface PairingStore {

    fun loadOrNull(): StoredPairing?

    fun save(pairing: StoredPairing)

    fun clear()
}
