package dev.jblaak.switchboard.link.discovery

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import dev.jblaak.switchboard.protocol.BONJOUR_SERVICE_TYPE
import java.net.Inet4Address
import java.net.InetAddress
import kotlin.coroutines.resume
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Looks up `_switchboard._tcp` with [NsdManager]: browses for a few seconds, then resolves what it found one at a
 * time (older Android versions refuse overlapping resolves). IPv4 only, as OkHttp cannot dial a scoped IPv6
 * link-local address.
 */
class NsdMacDiscovery(private val nsdManager: NsdManager) : MacDiscovery {

    override suspend fun discover(): List<MacAddress> {
        val services = mutableListOf<NsdServiceInfo>()
        withTimeoutOrNull(3.seconds) {
            foundServices().collect { found -> services += found }
        }
        return services
            .distinctBy { it.serviceName }
            .mapNotNull { service -> withTimeoutOrNull(2.seconds) { resolveOrNull(service) } }
            .distinct()
    }

    private fun foundServices(): Flow<NsdServiceInfo> = callbackFlow {
        var started = false
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                started = true
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                trySend(serviceInfo)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                close()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        }
        nsdManager.discoverServices(BONJOUR_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        awaitClose {
            if (started) nsdManager.stopServiceDiscovery(listener)
        }
    }

    @Suppress("DEPRECATION")
    private suspend fun resolveOrNull(service: NsdServiceInfo): MacAddress? = suspendCancellableCoroutine { continuation ->
        nsdManager.resolveService(
            service,
            object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    continuation.resume(null)
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val address = ipv4AddressOrNull(serviceInfo)
                    continuation.resume(address?.let { MacAddress(it.hostAddress.orEmpty(), serviceInfo.port) })
                }
            },
        )
    }

    @Suppress("DEPRECATION")
    private fun ipv4AddressOrNull(serviceInfo: NsdServiceInfo): InetAddress? {
        val addresses = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            serviceInfo.hostAddresses
        } else {
            listOfNotNull(serviceInfo.host)
        }
        return addresses.firstOrNull { it is Inet4Address }
    }
}
