package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.tls.sha256Fingerprint
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

/**
 * A stand-in for the Mac's listener on a real local socket: TLS with its own self-signed certificate, asking
 * every client for a certificate and accepting any (pinning, not a CA, decides; the Mac checks fingerprints
 * after the handshake). Each enqueued connection is a WebSocket answered by a script.
 */
internal class ScriptedMac : AutoCloseable {

    val certificate: HeldCertificate = HeldCertificate.Builder().commonName("Switchboard Mac").ecdsa256().build()
    val fingerprint: String = certificate.certificate.sha256Fingerprint()

    val server = MockWebServer()

    val address: MacAddress get() = MacAddress(server.hostName, server.port)

    init {
        val handshake = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val context = SSLContext.getInstance("TLS").apply {
            init(arrayOf(handshake.keyManager), arrayOf(AcceptAnyClient), null)
        }
        server.useHttps(context.socketFactory)
        server.requestClientAuth()
        server.start()
    }

    /** The next connection upgrades to a WebSocket whose text frames go to [script] by their `type`. */
    fun enqueueWebSocket(script: (type: String, webSocket: WebSocket) -> Unit) {
        val listener = object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val type = Json.parseToJsonElement(text).jsonObject.getValue("type").jsonPrimitive.content
                script(type, webSocket)
            }
        }
        server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build())
    }

    /** The fingerprint of the client certificate the next recorded connection presented. */
    fun takeClientFingerprintOrNull(): String? {
        val handshake = server.takeRequest().handshake ?: return null
        return (handshake.peerCertificates.firstOrNull() as? X509Certificate)?.sha256Fingerprint()
    }

    /**
     * The client certificate fingerprints of every connection recorded so far, in order;
     * null for a connection that presented none. Waits briefly for each, so a connection
     * still being recorded when the test asks is counted rather than missed.
     */
    fun clientFingerprints(): List<String?> = List(server.requestCount) {
        val request = server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS) ?: return@List null
        (request.handshake?.peerCertificates?.firstOrNull() as? X509Certificate)?.sha256Fingerprint()
    }

    override fun close() {
        server.close()
    }

    private object AcceptAnyClient : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
