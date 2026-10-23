package dev.jblaak.switchboard.ui.connected

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.session.TerminalSize
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SessionBoardTest {

    private val link = FakePhoneLink()

    private fun TestScope.newBoard() = SessionBoard(link, backgroundScope)

    @Test
    fun `the sessions message is the list, in the Mac's order`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()

        /* When */
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("b"), phoneSession("a"))))

        /* Then */
        assertEquals(listOf("b", "a"), board.sessions.value.map { it.id })
    }

    @Test
    fun `a re-key keeps the row in its place under the new id`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"), phoneSession("b"), phoneSession("c"))))

        /* When */
        link.macSays(ServerMessage.SessionRekeyed(from = "b", to = "b2"))

        /* Then */
        assertEquals(listOf("a", "b2", "c"), board.sessions.value.map { it.id })
    }

    @Test
    fun `a re-key moves the session's pending questions along`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        link.macSays(ServerMessage.Questions(listOf(pendingQuestions("b"))))

        /* When */
        link.macSays(ServerMessage.SessionRekeyed(from = "b", to = "b2"))

        /* Then */
        assertEquals(listOf("b2"), board.pending.value.map { it.sessionId })
    }

    @Test
    fun `an exited session leaves the list`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"), phoneSession("b"))))

        /* When */
        link.macSays(ServerMessage.Exited("a", exitCode = 0))

        /* Then */
        assertEquals(listOf("b"), board.sessions.value.map { it.id })
    }

    @Test
    fun `an owner change shows on the row`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"))))

        /* When */
        link.macSays(ServerMessage.Owner("a", THIS_PHONE))

        /* Then */
        assertEquals(THIS_PHONE, board.sessions.value.single().owner)
    }

    @Test
    fun `the last terminal size is remembered for Ask Patch`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()

        /* When */
        board.terminalMeasured(TerminalSize(48, 30))

        /* Then */
        assertEquals(TerminalSize(48, 30), board.terminalSize.value)
    }

    @Test
    fun `archiving sends archive and takes the session off the list at once`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"), phoneSession("b"))))

        /* When */
        val outcome = board.archive("a")

        /* Then */
        assertEquals(SendOutcome.Sent, outcome)
        assertEquals(listOf(ClientMessage.Archive("a")), link.sent)
        assertEquals(listOf("b"), board.sessions.value.map { it.id })
    }

    @Test
    fun `an archived session stays hidden while the Mac is still stopping it`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"), phoneSession("b"))))
        board.archive("a")

        /* When */
        link.macSays(ServerMessage.ArchiveResult("a", ok = true))
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"), phoneSession("b"))))

        /* Then */
        assertEquals(listOf("b"), board.sessions.value.map { it.id })
    }

    @Test
    fun `an archive the Mac could not do brings the session back and says why`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        val failures = mutableListOf<String>()
        backgroundScope.launch { board.archiveFailures.toList(failures) }
        runCurrent()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"), phoneSession("b"))))
        board.archive("a")

        /* When */
        link.macSays(ServerMessage.ArchiveResult("a", ok = false, error = "Could not stop it"))

        /* Then */
        assertEquals(listOf("a", "b"), board.sessions.value.map { it.id })
        assertEquals(listOf("Could not stop it"), failures)
    }

    @Test
    fun `archiving while not connected sends nothing and hides nothing`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val board = newBoard()
        link.macSays(ServerMessage.Sessions(listOf(phoneSession("a"))))
        link.state.value = LinkState.Reconnecting

        /* When */
        val outcome = board.archive("a")

        /* Then */
        assertEquals(SendOutcome.NotConnected, outcome)
        assertEquals(listOf("a"), board.sessions.value.map { it.id })
    }
}
