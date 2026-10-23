package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.transport.TransportEvent
import dev.jblaak.switchboard.link.transport.TransportFailure
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.TerminalFrame
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MacLinkTest {

    private val identity = SoftwareDeviceIdentity().apply { create() }
    private val store = InMemoryPairingStore(storedPairing())
    private val discovery = FakeDiscovery(emptyList())
    private val transport = FakeTransport { TransportEvent.Opened }

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

    private fun TestScope.connectedLink(): MacLink {
        val link = newLink()
        link.start()
        runCurrent()
        transport.last.macSays(WELCOME)
        runCurrent()
        return link
    }

    @Test
    fun `starting without a pairing settles on unpaired`() = runTest {
        /* Given */
        store.pairing = null
        val link = newLink()

        /* When */
        link.start()
        runCurrent()

        /* Then */
        assertEquals(LinkState.Unpaired, link.state.value)
    }

    @Test
    fun `starting with a pairing says hello to the last address`() = runTest {
        /* Given */
        val link = newLink()

        /* When */
        link.start()
        runCurrent()

        /* Then */
        assertEquals(lastAddress, transport.last.address)
        assertEquals(listOf(ClientMessage.Hello(protocol = 1, appVersion = "0.1.0")), transport.last.sent)
        assertEquals(LinkState.Connecting, link.state.value)
    }

    @Test
    fun `the connection pins the stored fingerprint`() = runTest {
        /* Given */
        val link = newLink()

        /* When */
        link.start()
        runCurrent()

        /* Then */
        assertEquals(MAC_FINGERPRINT, transport.last.macFingerprint)
    }

    @Test
    fun `a welcome connects`() = runTest {
        /* Given */
        val link = newLink()
        link.start()
        runCurrent()

        /* When */
        transport.last.macSays(WELCOME)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
    }

    @Test
    fun `the Mac is found through discovery when the last address does not answer`() = runTest {
        /* Given */
        val moved = MacAddress("192.168.1.31", 52840)
        discovery.found = listOf(moved)
        transport.firstEvent = { address ->
            if (address == moved) TransportEvent.Opened else TransportEvent.Failed(TransportFailure.Unreachable)
        }
        val link = newLink()

        /* When */
        link.start()
        runCurrent()
        transport.last.macSays(WELCOME)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
        assertEquals(moved, store.pairing?.lastAddress)
    }

    @Test
    fun `close 4001 asks for an app update`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        transport.last.macCloses(4001)
        runCurrent()

        /* Then */
        assertEquals(LinkState.UpdateRequired(macVersion = null), link.state.value)
    }

    @Test
    fun `an update-required answer to hello carries the Mac's version`() = runTest {
        /* Given */
        val link = newLink()
        link.start()
        runCurrent()

        /* When */
        transport.last.macSays("""{"type":"update-required","protocol":2,"macVersion":"2.9.0"}""")
        transport.last.macCloses(4001)
        runCurrent()

        /* Then */
        assertEquals(LinkState.UpdateRequired(macVersion = "2.9.0"), link.state.value)
    }

    @Test
    fun `close 4003 means no longer paired`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        transport.last.macSays("""{"type":"revoked"}""")
        transport.last.macCloses(4003)
        runCurrent()

        /* Then */
        assertEquals(LinkState.NotPaired, link.state.value)
    }

    @Test
    fun `a revoked message before close 4003 throws the key and the stored pairing away`() = runTest {
        /* Given */
        connectedLink()

        /* When */
        transport.last.macSays("""{"type":"revoked"}""")
        transport.last.macCloses(4003)
        runCurrent()

        /* Then */
        assertFalse(identity.exists())
        assertNull(store.pairing)
    }

    @Test
    fun `a bare close 4003 means no longer paired`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        transport.last.macCloses(4003)
        runCurrent()

        /* Then */
        assertEquals(LinkState.NotPaired, link.state.value)
    }

    @Test
    fun `a bare close 4003 keeps the key and the stored pairing`() = runTest {
        /* Given */
        connectedLink()

        /* When */
        transport.last.macCloses(4003)
        runCurrent()

        /* Then */
        assertTrue(identity.exists())
        assertEquals(storedPairing(), store.pairing)
    }

    @Test
    fun `close 4004 means Phone access was turned off`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        transport.last.macCloses(4004)
        runCurrent()

        /* Then */
        assertEquals(LinkState.TurnedOff, link.state.value)
    }

    @Test
    fun `close 4005 reconnects straight away`() = runTest {
        /* Given */
        connectedLink()
        val before = currentTime

        /* When */
        transport.last.macCloses(4005)
        runCurrent()

        /* Then */
        assertEquals(2, transport.connections.size)
        assertEquals(before, currentTime)
    }

    @Test
    fun `close 4000 reconnects silently after a pause`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        transport.last.macCloses(4000)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Reconnecting, link.state.value)
        assertEquals(1, transport.connections.size)
        advanceTimeBy(1.seconds + 1.seconds / 10)
        assertEquals(2, transport.connections.size)
    }

    @Test
    fun `a dropped connection reconnects into connected again`() = runTest {
        /* Given */
        val link = connectedLink()
        transport.last.mac(TransportEvent.Failed(TransportFailure.Dropped))
        advanceTimeBy(2.seconds)

        /* When */
        transport.last.macSays(WELCOME)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
    }

    @Test
    fun `a dropped connection with the key locked goes to locked`() = runTest {
        /* Given */
        val link = connectedLink()
        identity.locked = true

        /* When */
        transport.last.mac(TransportEvent.Failed(TransportFailure.Dropped))
        runCurrent()

        /* Then */
        assertEquals(LinkState.Locked, link.state.value)
    }

    @Test
    fun `an unreachable Mac is not found once the bounded attempts run out`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()

        /* When */
        link.start()
        settle()

        /* Then */
        assertEquals(LinkState.NotFound, link.state.value)
        assertEquals(5, transport.connections.size)
    }

    @Test
    fun `the attempts wait one, two, four and four seconds`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()

        /* When */
        link.start()
        val attemptsBySecond = (0..11).map { second ->
            if (second > 0) advanceTimeBy(1.seconds)
            runCurrent()
            transport.connections.size
        }

        /* Then */
        assertEquals(listOf(1, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5), attemptsBySecond)
    }

    @Test
    fun `retry after not found tries again`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Unreachable) }
        val link = newLink()
        link.start()
        settle()
        transport.firstEvent = { TransportEvent.Opened }

        /* When */
        link.retry()
        runCurrent()
        transport.last.macSays(WELCOME)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
    }

    @Test
    fun `being refused twice by the pinned Mac means no longer paired`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Refused) }
        val link = newLink()

        /* When */
        link.start()
        settle()

        /* Then */
        assertEquals(LinkState.NotPaired, link.state.value)
        assertEquals(2, transport.connections.size)
    }

    @Test
    fun `being refused twice keeps the key and the stored pairing for the user to decide`() = runTest {
        /* Given */
        transport.firstEvent = { TransportEvent.Failed(TransportFailure.Refused) }
        val link = newLink()

        /* When */
        link.start()
        settle()

        /* Then */
        assertTrue(identity.exists())
        assertEquals(storedPairing(), store.pairing)
    }

    @Test
    fun `a pairing answer to hello on a paired connection means no longer paired`() = runTest {
        /* Given */
        val link = newLink()
        link.start()
        runCurrent()

        /* When */
        transport.last.macSays("""{"type":"pairing","protocol":1,"macName":"Studio"}""")
        runCurrent()

        /* Then */
        assertEquals(LinkState.NotPaired, link.state.value)
    }

    @Test
    fun `a pairing answer to hello keeps the key and the stored pairing`() = runTest {
        /* Given */
        val link = newLink()
        link.start()
        runCurrent()

        /* When */
        transport.last.macSays("""{"type":"pairing","protocol":1,"macName":"Studio"}""")
        runCurrent()

        /* Then */
        assertTrue(identity.exists())
        assertEquals(storedPairing(), store.pairing)
    }

    @Test
    fun `a locked key at start goes to locked without connecting`() = runTest {
        /* Given */
        identity.locked = true
        val link = newLink()

        /* When */
        link.start()
        runCurrent()

        /* Then */
        assertEquals(LinkState.Locked, link.state.value)
        assertTrue(transport.connections.isEmpty())
    }

    @Test
    fun `unlocking connects`() = runTest {
        /* Given */
        identity.locked = true
        val link = newLink()
        link.start()
        runCurrent()
        identity.locked = false

        /* When */
        link.unlocked()
        runCurrent()
        transport.last.macSays(WELCOME)
        runCurrent()

        /* Then */
        assertEquals(LinkState.Connected(deviceId = "d-7", macName = "Studio"), link.state.value)
    }

    @Test
    fun `a key the system invalidated means no longer paired`() = runTest {
        /* Given */
        identity.delete()
        val link = newLink()

        /* When */
        link.start()
        runCurrent()

        /* Then */
        assertEquals(LinkState.NotPaired, link.state.value)
    }

    @Test
    fun `messages on the connection are forwarded`() = runTest {
        /* Given */
        val link = connectedLink()
        val messages = mutableListOf<ServerMessage>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { link.messages.toList(messages) }

        /* When */
        transport.last.macSays("""{"type":"projects","projects":[]}""")
        runCurrent()

        /* Then */
        assertEquals(listOf(ServerMessage.Projects(emptyList())), messages)
    }

    @Test
    fun `terminal frames on the connection are forwarded`() = runTest {
        /* Given */
        val link = connectedLink()
        val frames = mutableListOf<TerminalFrame>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { link.terminalFrames.toList(frames) }

        /* When */
        transport.last.mac(TransportEvent.Binary(byteArrayOf(0, 3) + "s-1hello".encodeToByteArray()))
        runCurrent()

        /* Then */
        assertEquals(listOf(TerminalFrame(sessionId = "s-1", output = "hello")), frames)
    }

    @Test
    fun `sending while connected goes out on the connection`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        val outcome = link.send(ClientMessage.UseHere(sessionId = "s-1"))

        /* Then */
        assertEquals(SendOutcome.Sent, outcome)
        assertEquals(ClientMessage.UseHere(sessionId = "s-1"), transport.last.sent.last())
    }

    @Test
    fun `sending before the welcome is not connected`() = runTest {
        /* Given */
        val link = newLink()
        link.start()
        runCurrent()

        /* When */
        val outcome = link.send(ClientMessage.ListProjects)

        /* Then */
        assertEquals(SendOutcome.NotConnected, outcome)
    }

    @Test
    fun `forgetting deletes the key and the pairing`() = runTest {
        /* Given */
        val link = connectedLink()

        /* When */
        link.forget()
        runCurrent()

        /* Then */
        assertEquals(LinkState.Unpaired, link.state.value)
        assertFalse(identity.exists())
        assertNull(store.pairing)
        assertTrue(transport.last.closedByPhone)
    }

    /** Runs the link's background work, backoff delays included, until it has nothing left to wait for. */
    private fun TestScope.settle() {
        advanceTimeBy(5.minutes)
        runCurrent()
    }
}
