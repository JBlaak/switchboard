package dev.jblaak.switchboard.ui.session

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.SessionState
import dev.jblaak.switchboard.protocol.TerminalOwner
import dev.jblaak.switchboard.protocol.WaitingReason
import dev.jblaak.switchboard.ui.connected.DEVICE_ID
import dev.jblaak.switchboard.ui.connected.FakePhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.connected.THIS_PHONE
import dev.jblaak.switchboard.ui.connected.pendingQuestions
import dev.jblaak.switchboard.ui.connected.phoneSession
import dev.jblaak.switchboard.ui.sessions.SessionStatus
import dev.jblaak.switchboard.ui.sessions.TerminalPlace
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionModelTest {

    private val link = FakePhoneLink()
    private val size = TerminalSize(48, 30)

    private fun TestScope.newModel(sessionId: String = "s-1", startedIn: String? = null): SessionModel {
        val board = SessionBoard(link, backgroundScope)
        return SessionModel(link, board, DEVICE_ID, sessionId, startedIn, backgroundScope)
    }

    private fun TestScope.writesOf(model: SessionModel): List<TerminalWrite> {
        val writes = mutableListOf<TerminalWrite>()
        backgroundScope.launch { model.terminalWrites.toList(writes) }
        runCurrent()
        return writes
    }

    @Test
    fun `an opened terminal attaches the session at its size`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.terminalOpened(size)

        /* Then */
        assertEquals(listOf(ClientMessage.Attach("s-1", 48, 30)), link.sent)
    }

    @Test
    fun `the terminal is reset before each replay`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        val writes = writesOf(model)

        /* When */
        model.terminalOpened(size)
        link.macStreams("s-1", "replayed")

        /* Then */
        assertEquals(listOf(TerminalWrite.Reset, TerminalWrite.Output("replayed")), writes)
    }

    @Test
    fun `output of other sessions is not written`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        val writes = writesOf(model)
        model.terminalOpened(size)

        /* When */
        link.macStreams("s-2", "elsewhere")

        /* Then */
        assertEquals(listOf(TerminalWrite.Reset), writes)
    }

    @Test
    fun `attached to a session this phone owns shows the terminal`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)

        /* When */
        link.macSays(ServerMessage.Attached("s-1", THIS_PHONE))

        /* Then */
        assertEquals(TerminalAccess.Here, model.state.value.access)
    }

    @Test
    fun `attached to a session the Mac owns shows active on other device`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)

        /* When */
        link.macSays(ServerMessage.Attached("s-1", TerminalOwner.Mac))

        /* Then */
        assertEquals(TerminalAccess.Elsewhere(TerminalPlace.Mac), model.state.value.access)
    }

    @Test
    fun `before attaching, the list's owner stands in`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("s-1", owner = TerminalOwner.Device("device-2", "Pixel 8")))))

        /* Then */
        assertEquals(TerminalAccess.Elsewhere(TerminalPlace.OtherPhone("Pixel 8")), model.state.value.access)
    }

    @Test
    fun `use here asks the Mac to make this phone active`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.useHere()

        /* Then */
        assertEquals(listOf(ClientMessage.UseHere("s-1")), link.sent)
    }

    @Test
    fun `the owner moving to this phone swaps the placeholder for the terminal`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)
        link.macSays(ServerMessage.Attached("s-1", TerminalOwner.Mac))

        /* When */
        link.macSays(ServerMessage.Owner("s-1", THIS_PHONE))

        /* Then */
        assertEquals(TerminalAccess.Here, model.state.value.access)
    }

    @Test
    fun `the owner moving to the Mac takes the terminal away`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)
        link.macSays(ServerMessage.Attached("s-1", THIS_PHONE))

        /* When */
        link.macSays(ServerMessage.Owner("s-1", TerminalOwner.Mac))

        /* Then */
        assertEquals(TerminalAccess.Elsewhere(TerminalPlace.Mac), model.state.value.access)
    }

    @Test
    fun `a new fit is reported as the size`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)
        link.sent.clear()

        /* When */
        model.terminalResized(TerminalSize(48, 18))

        /* Then */
        assertEquals(listOf(ClientMessage.Size("s-1", 48, 18)), link.sent)
    }

    @Test
    fun `an unchanged fit is not reported`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)
        link.sent.clear()

        /* When */
        model.terminalResized(size)

        /* Then */
        assertEquals(emptyList<ClientMessage>(), link.sent)
    }

    @Test
    fun `the prompt is pasted and Enter pressed a moment later`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.sendPrompt("fix the key bar\nthen test it")
        val beforeEnter = link.sent.toList()
        advanceTimeBy(151.milliseconds)

        /* Then */
        val paste = ClientMessage.Input("s-1", "\u001b[200~fix the key bar\nthen test it\u001b[201~")
        assertEquals(listOf(paste), beforeEnter)
        assertEquals(listOf(paste, ClientMessage.Input("s-1", "\r")), link.sent)
    }

    @Test
    fun `a blank prompt is not sent`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.sendPrompt("   ")

        /* Then */
        assertEquals(emptyList<ClientMessage>(), link.sent)
    }

    @Test
    fun `each key sends its bytes`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        TerminalKey.entries.forEach(model::press)

        /* Then */
        val bytes = link.sent.map { (it as ClientMessage.Input).data }
        assertEquals(listOf("\u001b", "\t", "\u001b[Z", "\u001b[A", "\u001b[B", "\u0003", "\r"), bytes)
    }

    @Test
    fun `the terminal's own input goes to the session`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.terminalInput("\u001b[<64;20;10M")

        /* Then */
        assertEquals(listOf(ClientMessage.Input("s-1", "\u001b[<64;20;10M")), link.sent)
    }

    @Test
    fun `a re-keyed session is followed under its new id`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        val writes = writesOf(model)
        model.terminalOpened(size)

        /* When */
        link.macSays(ServerMessage.SessionRekeyed(from = "s-1", to = "s-2"))
        link.macStreams("s-2", "after the fork")
        model.press(TerminalKey.Enter)

        /* Then */
        assertEquals("s-2", model.state.value.sessionId)
        assertEquals(TerminalWrite.Output("after the fork"), writes.last())
        assertEquals(ClientMessage.Input("s-2", "\r"), link.sent.last())
    }

    @Test
    fun `an exited session shows it ended`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)

        /* When */
        link.macSays(ServerMessage.Exited("s-1", exitCode = 0))

        /* Then */
        assertEquals(TerminalAccess.Ended, model.state.value.access)
    }

    @Test
    fun `after a reconnect the session is attached again from a reset screen`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        val writes = writesOf(model)
        model.terminalOpened(size)
        link.state.value = LinkState.Reconnecting
        link.sent.clear()

        /* When */
        link.state.value = LinkState.Connected(DEVICE_ID, "joris-mbp.local")

        /* Then */
        assertEquals(listOf(ClientMessage.Attach("s-1", 48, 30)), link.sent)
        assertEquals(listOf(TerminalWrite.Reset, TerminalWrite.Reset), writes)
    }

    @Test
    fun `leaving the session detaches it`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.terminalOpened(size)

        /* When */
        model.close()

        /* Then */
        assertEquals(ClientMessage.Detach("s-1"), link.sent.last())
    }

    @Test
    fun `pending questions for the session are offered`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        link.macSays(ServerMessage.Questions(listOf(pendingQuestions("s-2"), pendingQuestions("s-1", toolUseId = "toolu_9"))))

        /* Then */
        assertEquals("toolu_9", model.state.value.pendingQuestions?.toolUseId)
    }

    @Test
    fun `a session waiting in the terminal says so while no questions are pending`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("s-1", SessionState.NeedsYou, waiting = WaitingReason.Terminal))))

        /* Then */
        assertTrue(model.state.value.waitingInTerminal)
        assertEquals(SessionStatus.NeedsYou, model.state.value.status)
    }

    @Test
    fun `the started note goes once seen`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(startedIn = "switchboard")

        /* When */
        model.startedNoteDismissed()

        /* Then */
        assertEquals(null, model.state.value.startedIn)
        assertFalse(model.state.value.waitingInTerminal)
    }

    @Test
    fun `archive asks the Mac to archive the session under its current id`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        link.macSays(ServerMessage.SessionRekeyed(from = "s-1", to = "s-2"))

        /* When */
        val archived = model.archive()

        /* Then */
        assertTrue(archived)
        assertEquals(listOf(ClientMessage.Archive("s-2")), link.sent)
    }

    @Test
    fun `archive while not connected says so`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        link.state.value = LinkState.Reconnecting

        /* When */
        val archived = model.archive()

        /* Then */
        assertFalse(archived)
    }

    @Test
    fun `an archived session keeps its name and its terminal until the screen goes`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("s-1"))))
        model.terminalOpened(size)
        link.macSays(ServerMessage.Attached("s-1", THIS_PHONE))

        /* When */
        model.archive()
        link.macSays(ServerMessage.Exited("s-1", exitCode = 0))

        /* Then */
        assertEquals("Session s-1", model.state.value.name)
        assertEquals(TerminalAccess.Here, model.state.value.access)
    }
}
