package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.tls.sha256Fingerprint
import dev.jblaak.switchboard.link.transport.OkHttpLinkTransport
import dev.jblaak.switchboard.protocol.PairingInvite
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The whole pairing sequence against a scripted Mac over real mutual TLS. */
class MacLinkOverTlsTest {

    private val mac = ScriptedMac()
    private val identity = SoftwareDeviceIdentity()
    private val store = InMemoryPairingStore(null)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val link = MacLink(
        identity = identity,
        pairingStore = store,
        discovery = FakeDiscovery(emptyList()),
        transport = OkHttpLinkTransport(OkHttpLinkTransport.baseClient()),
        backoff = ReconnectBackoff(first = 1.seconds, cap = 4.seconds, attempts = 4),
        deviceName = "Pixel 9",
        appVersion = "0.1.0",
        scope = scope,
    )

    @After
    fun tearDown() {
        scope.cancel()
        mac.close()
    }

    private fun scriptPairingThenWelcome() {
        mac.enqueueWebSocket { type, webSocket ->
            when (type) {
                "hello" -> webSocket.send("""{"type":"pairing","protocol":1,"macName":"Studio"}""")
                "pair" -> {
                    webSocket.send("""{"type":"pair-pending"}""")
                    webSocket.send("""{"type":"pair-accepted","deviceId":"d-7"}""")
                    webSocket.close(4005, "Pairing over")
                }
            }
        }
        mac.enqueueWebSocket { type, webSocket -> if (type == "hello") webSocket.send(WELCOME) }
    }

    private fun invite() = PairingInvite(
        protocol = 1,
        fingerprint = mac.fingerprint,
        code = "482913",
        host = mac.address.host,
        port = mac.address.port,
    )

    @Test
    fun `pairing from an invite ends connected as the paired device`() {
        /* Given */
        scriptPairingThenWelcome()

        /* When */
        link.pair(invite())
        val connected = runBlocking { withTimeout(20.seconds) { link.state.first { it is LinkState.Connected } } }

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), connected)
    }

    @Test
    fun `pairing stores the Mac's fingerprint`() {
        /* Given */
        scriptPairingThenWelcome()

        /* When */
        link.pair(invite())
        runBlocking { withTimeout(20.seconds) { link.state.first { it is LinkState.Connected } } }

        /* Then */
        assertEquals(mac.fingerprint, store.pairing?.macFingerprint)
    }

    @Test
    fun `the paired connection presents the key the pairing ran with`() {
        /* Given */
        scriptPairingThenWelcome()

        /* When */
        link.pair(invite())
        runBlocking { withTimeout(20.seconds) { link.state.first { it is LinkState.Connected } } }

        /* Then */
        val deviceFingerprint = identity.held?.certificate?.sha256Fingerprint()
        val presented = mac.clientFingerprints()
        assertTrue("both the pairing and the paired connection reached the Mac: $presented", presented.size >= 2)
        assertEquals("every connection presented the pairing's key: $presented", listOf(deviceFingerprint), presented.distinct())
    }
}
