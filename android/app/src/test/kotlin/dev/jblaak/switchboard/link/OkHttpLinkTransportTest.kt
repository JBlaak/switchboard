package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.identity.DeviceKey
import dev.jblaak.switchboard.link.tls.sha256Fingerprint
import dev.jblaak.switchboard.link.transport.LinkConnection
import dev.jblaak.switchboard.link.transport.OkHttpLinkTransport
import dev.jblaak.switchboard.link.transport.TransportEvent
import dev.jblaak.switchboard.link.transport.TransportFailure
import java.util.concurrent.TimeUnit
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import mockwebserver3.MockResponse
import okhttp3.TlsVersion
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class OkHttpLinkTransportTest {

    private val mac = ScriptedMac()
    private val device = newDeviceCertificate()
    private val transport = OkHttpLinkTransport(OkHttpLinkTransport.baseClient())

    @After
    fun tearDown() {
        mac.close()
    }

    private fun open(pinnedFingerprint: String): LinkConnection {
        val key = DeviceKey(device.keyPair.private, listOf(device.certificate))
        return transport.open(mac.address, key, pinnedFingerprint)
    }

    private fun LinkConnection.nextEvent(): TransportEvent = runBlocking {
        withTimeout(10.seconds) { events.receive() }
    }

    @Test
    fun `the pinned Mac opens the WebSocket`() {
        /* Given */
        mac.enqueueWebSocket { _, _ -> }

        /* When */
        val event = open(mac.fingerprint).nextEvent()

        /* Then */
        assertEquals(TransportEvent.Opened, event)
    }

    @Test
    fun `a server with any other certificate is refused as the wrong Mac`() {
        /* Given */
        mac.enqueueWebSocket { _, _ -> }
        val otherFingerprint = newDeviceCertificate().certificate.sha256Fingerprint()

        /* When */
        val event = open(otherFingerprint).nextEvent()

        /* Then */
        assertEquals(TransportEvent.Failed(TransportFailure.WrongMac), event)
    }

    @Test
    fun `the device certificate is presented to the Mac`() {
        /* Given */
        mac.enqueueWebSocket { _, _ -> }

        /* When */
        open(mac.fingerprint).nextEvent()

        /* Then */
        assertEquals(device.certificate.sha256Fingerprint(), mac.takeClientFingerprintOrNull())
    }

    @Test
    fun `the handshake is TLS 1·3`() {
        /* Given */
        mac.enqueueWebSocket { _, _ -> }

        /* When */
        open(mac.fingerprint).nextEvent()

        /* Then */
        assertEquals(TlsVersion.TLS_1_3, mac.server.takeRequest(10, TimeUnit.SECONDS)?.handshake?.tlsVersion)
    }

    @Test
    fun `the pinned Mac turning the connection away is a refusal`() {
        /* Given */
        mac.server.enqueue(MockResponse.Builder().code(426).build())

        /* When */
        val event = open(mac.fingerprint).nextEvent()

        /* Then */
        assertEquals(TransportEvent.Failed(TransportFailure.Refused), event)
    }

    @Test
    fun `text frames from the Mac arrive as text`() {
        /* Given */
        mac.enqueueWebSocket { type, webSocket -> if (type == "hello") webSocket.send(WELCOME) }
        val connection = open(mac.fingerprint)
        connection.nextEvent()

        /* When */
        connection.send("""{"type":"hello","protocol":1,"appVersion":"0.1.0"}""")

        /* Then */
        assertEquals(TransportEvent.Text(WELCOME), connection.nextEvent())
    }

    @Test
    fun `binary frames from the Mac arrive as bytes`() {
        /* Given */
        val frame = byteArrayOf(0, 3) + "s-1hello".encodeToByteArray()
        mac.enqueueWebSocket { _, webSocket -> webSocket.send(frame.toByteString()) }
        val connection = open(mac.fingerprint)
        connection.nextEvent()

        /* When */
        connection.send("""{"type":"list-projects"}""")

        /* Then */
        val event = connection.nextEvent() as TransportEvent.Binary
        assertEquals(frame.toList(), event.bytes.toList())
    }

    @Test
    fun `a close from the Mac carries its code`() {
        /* Given */
        mac.enqueueWebSocket { _, webSocket -> webSocket.close(4003, "Revoked") }
        val connection = open(mac.fingerprint)
        connection.nextEvent()

        /* When */
        connection.send("""{"type":"list-projects"}""")

        /* Then */
        assertEquals(TransportEvent.Closed(4003, "Revoked"), connection.nextEvent())
    }
}
