package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.pairing.StoredPairing
import dev.jblaak.switchboard.link.transport.TransportEvent
import dev.jblaak.switchboard.link.transport.TransportFailure
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PairRejection
import dev.jblaak.switchboard.protocol.PairingInvite
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MacLinkPairingTest {

    private val identity = SoftwareDeviceIdentity()
    private val store = InMemoryPairingStore(null)
    private val discovery = FakeDiscovery(emptyList())
    private val transport = FakeTransport { TransportEvent.Opened }

    private val invite = PairingInvite(
        protocol = 1,
        fingerprint = MAC_FINGERPRINT,
        code = "482913",
        host = "studio.local",
        port = 52840,
    )

    private fun TestScope.newLink() = MacLink(
        identity = identity,
        pairingStore = store,
        discovery = discovery,
        transport = transport,
        backoff = ReconnectBackoff(first = 1.seconds, cap = 4.seconds, attempts = 4),
        deviceName = "Pixel 9",
        appVersion = "0.1.0",
        scope = backgroundScope,
    )

    private fun TestScope.pairingLink(): MacLink {
        val link = newLink()
        link.pair(invite)
        runCurrent()
        transport.last.macSays("""{"type":"pairing","protocol":1,"macName":"Studio"}""")
        runCurrent()
        return link
    }

    @Test
    fun `an invite for another protocol is turned down without making a key`() = runTest {
        /* Given */
        val link = newLink()

        /* When */
        link.pair(invite.copy(protocol = 2))
        runCurrent()

        /* Then */
        assertEquals(LinkState.PairFailed(PairFailure.ProtocolMismatch(macProtocol = 2)), link.state.value)
        assertEquals(0, identity.created)
    }

    @Test
    fun `pairing makes a key and says hello to the invited address`() = runTest {
        /* Given */
        val link = newLink()

        /* When */
        link.pair(invite)
        runCurrent()

        /* Then */
        assertTrue(identity.exists())
        assertEquals(MacAddress("studio.local", 52840), transport.last.address)
        assertEquals(MAC_FINGERPRINT, transport.last.macFingerprint)
        assertEquals(listOf(ClientMessage.Hello(protocol = 1, appVersion = "0.1.0")), transport.last.sent)
    }

    @Test
    fun `a pairing answer sends the code with the device name`() = runTest {
        /* Given */
        val link = newLink()
        link.pair(invite)
        runCurrent()

        /* When */
        transport.last.macSays("""{"type":"pairing","protocol":1,"macName":"Studio"}""")
        runCurrent()

        /* Then */
        assertEquals(LinkState.Pairing(macName = "Studio"), link.state.value)
        assertEquals(ClientMessage.Pair(code = "482913", deviceName = "Pixel 9"), transport.last.sent.last())
    }

    @Test
    fun `pair-pending waits for the confirm on the Mac`() = runTest {
        /* Given */
        val link = pairingLink()

        /* When */
        transport.last.macSays("""{"type":"pair-pending"}""")
        runCurrent()

        /* Then */
        assertEquals(LinkState.PairPending(macName = "Studio"), link.state.value)
    }

    @Test
    fun `an accepted pairing stores the pinned fingerprint and reconnects as paired`() = runTest {
        /* Given */
        val link = pairingLink()
        transport.last.macSays("""{"type":"pair-pending"}""")

        /* When */
        transport.last.macSays("""{"type":"pair-accepted","deviceId":"d-7"}""")
        transport.last.macCloses(4005)
        runCurrent()
        transport.last.macSays(WELCOME)
        runCurrent()

        /* Then */
        assertEquals(
            StoredPairing(MAC_FINGERPRINT, "d-7", "Studio", MacAddress("studio.local", 52840)),
            store.pairing,
        )
        assertEquals(2, transport.connections.size)
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
    }

    @Test
    fun `a rejected code fails the pairing and drops the key`() = runTest {
        /* Given */
        val link = pairingLink()

        /* When */
        transport.last.macSays("""{"type":"pair-rejected","reason":"wrong-code"}""")
        transport.last.macCloses(4005)
        runCurrent()

        /* Then */
        assertEquals(LinkState.PairFailed(PairFailure.Rejected(PairRejection.WrongCode)), link.state.value)
        assertFalse(identity.exists())
        assertNull(store.pairing)
    }

    @Test
    fun `a Mac with another certificate fails the pairing as the wrong Mac`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.WrongMac) }
        val link = newLink()

        /* When */
        link.pair(invite)
        settle()

        /* Then */
        assertEquals(LinkState.PairFailed(PairFailure.WrongMac), link.state.value)
    }

    @Test
    fun `the invited host is found through discovery when its name does not resolve`() = runTest {
        /* Given */
        val found = MacAddress("192.168.1.20", 52840)
        discovery.found = listOf(found)
        transport.firstEvent = { address ->
            if (address == found) TransportEvent.Opened else TransportEvent.Failed(TransportFailure.Unreachable)
        }
        val link = newLink()

        /* When */
        link.pair(invite)
        runCurrent()

        /* Then */
        assertEquals(found, transport.last.address)
        assertEquals(LinkState.Connecting, link.state.value)
    }

    @Test
    fun `a Mac that refuses the new key has no pairing code live`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Refused) }
        val link = newLink()

        /* When */
        link.pair(invite)
        settle()

        /* Then */
        assertEquals(LinkState.PairFailed(PairFailure.NotPairing), link.state.value)
    }

    @Test
    fun `no Mac at all fails the pairing as not found`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()

        /* When */
        link.pair(invite)
        settle()

        /* Then */
        assertEquals(LinkState.PairFailed(PairFailure.NotFound), link.state.value)
    }

    @Test
    fun `a phone without biometrics cannot pair`() = runTest {
        /* Given */
        identity.biometricsEnrolled = false
        val link = newLink()

        /* When */
        link.pair(invite)
        runCurrent()

        /* Then */
        assertEquals(LinkState.PairFailed(PairFailure.BiometricsUnavailable), link.state.value)
        assertTrue(transport.connections.isEmpty())
    }

    @Test
    fun `a locked new key resumes the pairing after the unlock with the same key`() = runTest {
        /* Given */
        identity.locked = true
        val link = newLink()
        link.pair(invite)
        runCurrent()
        identity.locked = false

        /* When */
        link.unlocked()
        runCurrent()

        /* Then */
        assertEquals(1, identity.created)
        assertEquals(listOf(ClientMessage.Hello(protocol = 1, appVersion = "0.1.0")), transport.last.sent)
    }

    @Test
    fun `pairing over an existing pairing replaces it`() = runTest {
        /* Given */
        store.pairing = storedPairing().copy(macFingerprint = "bb".repeat(32))
        val link = newLink()

        /* When */
        link.pair(invite)
        runCurrent()

        /* Then */
        assertNull(store.pairing)
        assertEquals(MAC_FINGERPRINT, transport.last.macFingerprint)
    }

    /** Runs the link's background work, backoff delays included, until it has nothing left to wait for. */
    private fun TestScope.settle() {
        advanceTimeBy(5.minutes)
        runCurrent()
    }
}
