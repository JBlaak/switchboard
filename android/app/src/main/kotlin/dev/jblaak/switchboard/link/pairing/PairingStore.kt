package dev.jblaak.switchboard.link.pairing

import dev.jblaak.switchboard.link.discovery.MacAddress

/** What the phone keeps of a pairing besides its key: who the Mac is and where it was last reached. */
data class StoredPairing(
    /** The Mac's pinned certificate fingerprint, from the pairing QR code. */
    val macFingerprint: String,
    val deviceId: String,
    val macName: String,
    /** The last address a connection worked on: the first one tried. */
    val lastAddress: MacAddress,
    /**
     * The hosts the Mac listed in its last `welcome`, on [lastAddress]'s port: tried when the last address doesn't
     * answer, before Bonjour, so a phone on the Mac's VPN (which Bonjour can't cross) still finds it.
     */
    val knownHosts: List<String> = emptyList(),
)

interface PairingStore {

    fun loadOrNull(): StoredPairing?

    fun save(pairing: StoredPairing)

    fun clear()
}
