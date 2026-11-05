package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.transport.TransportEvent
import dev.jblaak.switchboard.link.transport.TransportFailure
import dev.jblaak.switchboard.protocol.PairingInvite
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** [MacLink.nudge], [MacLink.networkChanged], [MacLink.lastConnected] and what the link logs. */
@OptIn(ExperimentalCoroutinesApi::class)
class MacLinkNudgeTest {

    private val identity = SoftwareDeviceIdentity().apply { create() }
    private val store = InMemoryPairingStore(storedPairing())
    private val discovery = FakeDiscovery(emptyList())
    private val transport = FakeTransport { TransportEvent.Opened }
    private val logger = RecordingLinkLogger()

    private fun TestScope.newLink() = MacLink(
        identity = identity,
        pairingStore = store,
        discovery = discovery,
        transport = transport,
        backoff = ReconnectBackoff(first = 1.seconds, cap = 4.seconds, attempts = 4),
        deviceName = "Pixel 9",
        appVersion = "0.1.0",
        scope = backgroundScope,
        logger = logger,
    )

    private fun TestScope.connectedLink(): MacLink {
        val link = newLink()
        link.start()
        runCurrent()
        transport.last.macSays(WELCOME)
        runCurrent()
        return link
    }

    private fun TestScope.notFoundLink(): MacLink {
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()
        link.start()
        settle()
        return link
    }

    @Test
    fun `a nudge from not found dials at once`() = runTest {
        /* Given */
        val link = notFoundLink()
        val dialled = transport.connections.size
        val before = currentTime

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(dialled + 1, transport.connections.size)
        assertEquals(before, currentTime)
    }

    @Test
    fun `a nudge from not found gets a fresh set of attempts`() = runTest {
        /* Given */
        val link = notFoundLink()
        val dialled = transport.connections.size

        /* When */
        link.nudge("test")
        settle()

        /* Then */
        assertEquals(dialled * 2, transport.connections.size)
        assertEquals(LinkState.NotFound, link.state.value)
    }

    @Test
    fun `a nudge from not found that reaches the Mac connects`() = runTest {
        /* Given */
        val link = notFoundLink()
        transport.firstEvent = { TransportEvent.Opened }

        /* When */
        link.nudge("test")
        runCurrent()
        transport.last.macSays(WELCOME)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
    }

    @Test
    fun `a nudge during the backoff wait dials without waiting`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()
        link.start()
        runCurrent()
        advanceTimeBy(1.seconds + 1.seconds / 10)
        assertEquals(2, transport.connections.size)
        val before = currentTime

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(3, transport.connections.size)
        assertEquals(before, currentTime)
    }

    @Test
    fun `a nudge while reconnecting dials at once and keeps reconnecting`() = runTest {
        /* Given */
        val link = connectedLink()
        transport.last.macCloses(4000)
        runCurrent()
        assertEquals(1, transport.connections.size)

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(2, transport.connections.size)
        assertEquals(LinkState.Reconnecting, link.state.value)
    }

    @Test
    fun `a nudge while connected does nothing`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
        assertEquals(1, transport.connections.size)
        assertFalse(transport.last.closedByPhone)
    }

    @Test
    fun `a nudge while locked does nothing`() = runTest {
        /* Given */
        identity.locked = true
        val link = newLink()
        link.start()
        runCurrent()

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(LinkState.Locked, link.state.value)
        assertTrue(transport.connections.isEmpty())
    }

    @Test
    fun `a nudge does not interrupt a dial under way`() = runTest {
        /* Given */
        val link = newLink()
        link.start()
        runCurrent()

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(1, transport.connections.size)
        assertFalse(transport.last.closedByPhone)
    }

    @Test
    fun `a nudge right after pairing starts does not interrupt the pairing`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()
        link.start()
        runCurrent()
        transport.firstEvent = { TransportEvent.Opened }
        link.pair(PairingInvite(protocol = 1, fingerprint = MAC_FINGERPRINT, code = "482913", host = "studio.local", port = 52840))

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(MacAddress("studio.local", 52840), transport.last.address)
        assertEquals(2, transport.connections.size)
    }

    @Test
    fun `a nudge while turned off does nothing`() = runTest {
        /* Given */
        val link = connectedLink()
        transport.last.macCloses(4004)
        runCurrent()

        /* When */
        link.nudge("test")
        runCurrent()

        /* Then */
        assertEquals(LinkState.TurnedOff, link.state.value)
        assertEquals(1, transport.connections.size)
    }

    @Test
    fun `a network change that takes the connection's address away dials again at once`() = runTest {
        /* Given */
        val link = connectedLink()
        val before = currentTime

        /* When */
        link.networkChanged(setOf("10.0.0.7"))
        runCurrent()

        /* Then */
        assertTrue(transport.connections.first().closedByPhone)
        assertEquals(2, transport.connections.size)
        assertEquals(LinkState.Reconnecting, link.state.value)
        assertEquals(before, currentTime)
    }

    @Test
    fun `a network change that keeps the connection's address leaves it alone`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        link.networkChanged(setOf(PHONE_ADDRESS, "10.8.0.2"))
        runCurrent()

        /* Then */
        assertFalse(transport.last.closedByPhone)
        assertEquals(1, transport.connections.size)
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
    }

    @Test
    fun `a network change leaves a connection from an unknown address alone`() = runTest {
        /* Given */
        val link = connectedLink()
        transport.last.localAddress = null

        /* When */
        link.networkChanged(setOf("10.0.0.7"))
        runCurrent()

        /* Then */
        assertFalse(transport.last.closedByPhone)
        assertEquals(1, transport.connections.size)
    }

    @Test
    fun `a network change while not found dials at once`() = runTest {
        /* Given */
        val link = notFoundLink()
        val dialled = transport.connections.size

        /* When */
        link.networkChanged(setOf(PHONE_ADDRESS))
        runCurrent()

        /* Then */
        assertEquals(dialled + 1, transport.connections.size)
    }

    @Test
    fun `the last connection is kept while reconnecting`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        transport.last.macCloses(4000)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Reconnecting, link.state.value)
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.lastConnected.value)
    }

    @Test
    fun `forgetting the Mac forgets the last connection`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        link.forget()
        runCurrent()

        /* Then */
        assertNull(link.lastConnected.value)
        assertNull(link.lastConnectedOrStored())
    }

    @Test
    fun `before any connection the stored pairing stands in for the last one`() = runTest {
        /* Given */
        val link = newLink()

        /* When */
        val connected = link.lastConnectedOrStored()

        /* Then */
        assertNull(link.lastConnected.value)
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), connected)
    }

    @Test
    fun `a failed dial is logged with its address and where it came from`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()

        /* When */
        link.start()
        runCurrent()

        /* Then */
        assertTrue(logger.lines.any { "192.168.1.20:52840 (last address) failed: Unreachable" in it })
    }

    @Test
    fun `the log never holds the whole fingerprint`() = runTest {
        /* Given */
        val link = newLink()

        /* When */
        link.start()
        runCurrent()

        /* Then */
        assertTrue(logger.lines.any { "aa11aa11…" in it })
        assertFalse(logger.lines.any { MAC_FINGERPRINT in it })
    }

    /** Runs the link's background work, backoff delays included, until it has nothing left to wait for. */
    private fun TestScope.settle() {
        advanceTimeBy(5.minutes)
        runCurrent()
    }
}
