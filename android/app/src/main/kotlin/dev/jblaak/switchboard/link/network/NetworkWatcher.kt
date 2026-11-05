package dev.jblaak.switchboard.link.network

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import dev.jblaak.switchboard.link.LinkLogger
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.launch

/**
 * Follows the phone's default network and calls [onChanged] on the main thread with every address the phone has
 * on any network, about half a second after the default network was replaced, lost, or changed its addresses (so a
 * Wi-Fi hand-over's burst of callbacks is one call). Capability changes alone don't count.
 */
class NetworkWatcher(
    private val connectivity: ConnectivityManager,
    private val scope: CoroutineScope,
    private val logger: LinkLogger,
    private val onChanged: (phoneAddresses: Set<String>) -> Unit,
) {

    private val tracker = DefaultNetworkTracker()

    private val changes = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            logger.info("Network: $network is the default now")
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            val addresses = linkProperties.hostAddresses()
            if (tracker.linkPropertiesChanged(network.toString(), addresses)) {
                logger.info("Network: $network (${linkProperties.interfaceName}) has ${addresses.ifEmpty { "no addresses" }}")
                changes.tryEmit(Unit)
            }
        }

        override fun onLost(network: Network) {
            if (tracker.lost(network.toString())) {
                logger.info("Network: lost the default network $network")
                changes.tryEmit(Unit)
            }
        }
    }

    @OptIn(FlowPreview::class)
    fun start() {
        scope.launch(Dispatchers.Main.immediate) {
            changes.debounce(500.milliseconds).collect { onChanged(phoneAddresses()) }
        }
        connectivity.registerDefaultNetworkCallback(callback)
    }

    /** Every address on every network the phone has up, the VPN's included. */
    @Suppress("DEPRECATION")
    private fun phoneAddresses(): Set<String> {
        return connectivity.allNetworks
            .mapNotNull { connectivity.getLinkProperties(it) }
            .flatMapTo(mutableSetOf()) { it.hostAddresses() }
    }

    private fun LinkProperties.hostAddresses(): Set<String> {
        return linkAddresses.mapNotNullTo(mutableSetOf()) { it.address.hostAddress?.substringBefore('%') }
    }
}
