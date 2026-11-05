package dev.jblaak.switchboard.link.discovery

import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import dev.jblaak.switchboard.link.LinkLogger
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
 * link-local address. What it finds, and every failure with NSD's error code, goes to [logger].
 */
class NsdMacDiscovery(
    private val nsdManager: NsdManager,
    private val logger: LinkLogger = LinkLogger.Silent,
) : MacDiscovery {

    override suspend fun discover(): List<MacAddress> {
        logger.info("Bonjour: browsing for $BONJOUR_SERVICE_TYPE")
        val services = mutableListOf<NsdServiceInfo>()
        withTimeoutOrNull(3.seconds) {
            foundServices().collect { found -> services += found }
        }
        val distinct = services.distinctBy { it.serviceName }
        logger.info("Bonjour: found ${distinct.size} service(s): ${distinct.joinToString { it.serviceName }}")
        val resolved = distinct.mapNotNull { service -> resolveInTimeOrNull(service) }.distinct()
        logger.info("Bonjour: resolved ${resolved.joinToString { "${it.host}:${it.port}" }.ifEmpty { "nothing" }}")
        return resolved
    }

    private suspend fun resolveInTimeOrNull(service: NsdServiceInfo): MacAddress? {
        var answered = false
        val address = withTimeoutOrNull(2.seconds) { resolveOrNull(service).also { answered = true } }
        if (!answered) logger.warn("Bonjour: resolving ${service.serviceName} timed out")
        return address
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
                logger.warn("Bonjour: discovery failed to start, error $errorCode")
                close()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                logger.warn("Bonjour: discovery failed to stop, error $errorCode")
            }
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
                    logger.warn("Bonjour: resolving ${serviceInfo.serviceName} failed, error $errorCode")
                    continuation.resume(null)
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val address = ipv4AddressOrNull(serviceInfo)
                    if (address == null) logger.warn("Bonjour: ${serviceInfo.serviceName} resolved without an IPv4 address")
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
