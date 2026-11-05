package dev.jblaak.switchboard.link.network

/**
 * Tells which default-network callbacks are a change the link should hear of: another network taking over, the
 * default network's addresses changing, or the default network going away. Capability churn and repeats of the
 * same addresses are not. Networks are compared by their id (`Network.toString()`).
 */
class DefaultNetworkTracker {

    private var network: String? = null
    private var addresses: Set<String> = emptySet()

    /** The default network is [network] with [addresses]; true when either differs from what was seen last. */
    fun linkPropertiesChanged(network: String, addresses: Set<String>): Boolean {
        val changed = network != this.network || addresses != this.addresses
        this.network = network
        this.addresses = addresses
        return changed
    }

    /** [network] was lost; true when it was the default one. */
    fun lost(network: String): Boolean {
        if (network != this.network) return false
        this.network = null
        addresses = emptySet()
        return true
    }
}
