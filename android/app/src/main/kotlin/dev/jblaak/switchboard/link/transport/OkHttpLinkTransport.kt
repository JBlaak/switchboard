package dev.jblaak.switchboard.link.transport

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.identity.DeviceKey
import dev.jblaak.switchboard.link.tls.DeviceKeyManager
import dev.jblaak.switchboard.link.tls.PinVerdict
import dev.jblaak.switchboard.link.tls.PinnedTrustManager
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLContext
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ReceiveChannel
import okhttp3.ConnectionSpec
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.TlsVersion
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * The [LinkTransport] over an OkHttp WebSocket. Each connection gets its own TLS context, as the key and the pin
 * belong to that attempt; [baseClient] contributes the dispatcher, connection pool and timeouts.
 */
class OkHttpLinkTransport(private val baseClient: OkHttpClient) : LinkTransport {

    override fun open(address: MacAddress, key: DeviceKey, macFingerprint: String): LinkConnection {
        val trustManager = PinnedTrustManager(macFingerprint)
        val sslContext = SSLContext.getInstance("TLSv1.3").apply {
            init(arrayOf(DeviceKeyManager(key)), arrayOf(trustManager), null)
        }
        val client = baseClient.newBuilder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .connectionSpecs(listOf(ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS).tlsVersions(TlsVersion.TLS_1_3).build()))
            .hostnameVerifier { _, _ -> true }
            .retryOnConnectionFailure(false)
            .build()
        val url = HttpUrl.Builder().scheme("https").host(address.host).port(address.port).build()
        val listener = ChannelListener(trustManager)
        val webSocket = client.newWebSocket(Request.Builder().url(url).build(), listener)
        return OkHttpLinkConnection(webSocket, listener.events)
    }

    companion object {
        /** The shared client every connection derives from: short connect timeout, a ping to notice a dead Mac. */
        fun baseClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .pingInterval(15, TimeUnit.SECONDS)
                .build()
        }
    }
}

private class OkHttpLinkConnection(
    private val webSocket: WebSocket,
    override val events: ReceiveChannel<TransportEvent>,
) : LinkConnection {

    override fun send(text: String): Boolean = webSocket.send(text)

    override fun close(code: Int, reason: String) {
        if (!webSocket.close(code, reason)) webSocket.cancel()
    }
}

private class ChannelListener(private val trustManager: PinnedTrustManager) : WebSocketListener() {

    val events = Channel<TransportEvent>(Channel.UNLIMITED)

    private val opened = AtomicBoolean(false)

    override fun onOpen(webSocket: WebSocket, response: Response) {
        opened.set(true)
        events.trySend(TransportEvent.Opened)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        events.trySend(TransportEvent.Text(text))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        events.trySend(TransportEvent.Binary(bytes.toByteArray()))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        end(TransportEvent.Closed(code, reason))
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        end(TransportEvent.Closed(code, reason))
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        end(TransportEvent.Failed(failureOf(response)))
    }

    private fun failureOf(response: Response?): TransportFailure {
        return when {
            opened.get() -> TransportFailure.Dropped
            trustManager.verdict == PinVerdict.Mismatched -> TransportFailure.WrongMac
            trustManager.verdict == PinVerdict.Matched || response != null -> TransportFailure.Refused
            else -> TransportFailure.Unreachable
        }
    }

    private fun end(event: TransportEvent) {
        events.trySend(event)
        events.close()
    }
}
