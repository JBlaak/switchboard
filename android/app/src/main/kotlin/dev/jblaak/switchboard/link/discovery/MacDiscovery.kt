package dev.jblaak.switchboard.link.discovery

/** Where a Mac listens. Only the pinned certificate says whether it is the paired one. */
data class MacAddress(val host: String, val port: Int)

/** Finds the Macs advertising Switchboard on the local network. */
interface MacDiscovery {

    /** Every Mac that answered within the lookup window; empty when none did. */
    suspend fun discover(): List<MacAddress>
}
