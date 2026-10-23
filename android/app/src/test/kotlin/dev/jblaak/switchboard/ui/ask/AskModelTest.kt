package dev.jblaak.switchboard.ui.ask

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.protocol.AskCandidate
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PhoneAskResult
import dev.jblaak.switchboard.protocol.PhoneProject
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.connected.FakePhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.session.TerminalSize
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AskModelTest {

    private val link = FakePhoneLink()
    private val events = RecordingEvents()
    private var requests = 0

    private val switchboard = "/Users/joris/Development/JBlaak/switchboard"
    private val patch = "/Users/joris/Development/JBlaak/patch"

    private fun TestScope.newModel(size: TerminalSize? = TerminalSize(48, 30)): AskModel {
        val board = SessionBoard(link, backgroundScope)
        size?.let(board::terminalMeasured)
        return AskModel(link, board, events, newRequestId = { "r-${++requests}" }, backgroundScope)
    }

    private fun TestScope.askedModel(text: String = "wrap the key bar"): AskModel {
        val model = newModel()
        model.type(text)
        model.ask()
        return model
    }

    @Test
    fun `asking sends the text at this phone's terminal size`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.type("  wrap the key bar  ")

        /* When */
        model.ask()

        /* Then */
        assertEquals(listOf(ClientMessage.Ask("r-1", "wrap the key bar", 48, 30)), link.sent)
        assertEquals(AskStep.Compose("  wrap the key bar  ", thinking = true, problem = null), model.state.value)
    }

    @Test
    fun `without a terminal size yet the ask leaves it out`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(size = null)
        model.type("wrap the key bar")

        /* When */
        model.ask()

        /* Then */
        assertEquals(listOf(ClientMessage.Ask("r-1", "wrap the key bar", null, null)), link.sent)
    }

    @Test
    fun `a confident answer opens the session Patch started`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        askedModel()

        /* When */
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Confident("s-9", "switchboard")))

        /* Then */
        assertEquals(listOf("s-9" to "switchboard"), events.started)
    }

    @Test
    fun `an unsure answer offers Patch's guesses with its first prompt`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()
        val candidates = listOf(AskCandidate(switchboard, "switchboard", "Phone access"), AskCandidate(patch, "patch", null))

        /* When */
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Unsure(candidates, "Make the key bar wrap.")))

        /* Then */
        assertEquals(AskStep.Pick("wrap the key bar", candidates, "Make the key bar wrap.", null, null), model.state.value)
    }

    @Test
    fun `starting a guess sends Patch's prompt to that project`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Unsure(listOf(AskCandidate(patch, "patch", null)), "Make it wrap.")))

        /* When */
        model.start(patch)

        /* Then */
        assertEquals(ClientMessage.AskStart("r-2", patch, "Make it wrap.", 48, 30), link.sent.last())
    }

    @Test
    fun `a started guess opens the new session`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Unsure(listOf(AskCandidate(patch, "patch", null)), "Make it wrap.")))
        model.start(patch)

        /* When */
        link.macSays(ServerMessage.AskStarted("r-2", "s-10"))

        /* Then */
        assertEquals(listOf("s-10" to "patch"), events.started)
    }

    @Test
    fun `no match shows Patch's line over the project list`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()

        /* When */
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.NoMatch("That doesn't sound like any project.")))

        /* Then */
        val step = model.state.value as AskStep.Projects
        assertEquals(ProjectsReason.NoMatch("That doesn't sound like any project."), step.reason)
        assertEquals(ClientMessage.ListProjects, link.sent.last())
    }

    @Test
    fun `a project picked after no match gets the request word for word`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel("wrap the key bar")
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.NoMatch("No idea.")))

        /* When */
        model.start(switchboard)

        /* Then */
        assertEquals(ClientMessage.AskStart("r-2", switchboard, "wrap the key bar", 48, 30), link.sent.last())
    }

    @Test
    fun `a failed routing call leaves the pick to the user`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()

        /* When */
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Failed("claude timed out")))

        /* Then */
        assertEquals(ProjectsReason.Failed("claude timed out"), (model.state.value as AskStep.Projects).reason)
    }

    @Test
    fun `the project list fills in and filters`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.NoMatch("No idea.")))

        /* When */
        link.macSays(ServerMessage.Projects(listOf(PhoneProject(switchboard, "switchboard", 2), PhoneProject(patch, "patch", 0))))
        model.filter("PAT")

        /* Then */
        assertEquals(listOf("patch"), (model.state.value as AskStep.Projects).shown.map { it.folder })
    }

    @Test
    fun `a cancelled routing call goes back to the ask box`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()

        /* When */
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Cancelled))

        /* Then */
        assertEquals(AskStep.Compose("wrap the key bar", thinking = false, problem = null), model.state.value)
    }

    @Test
    fun `back while Patch thinks cancels the call`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()

        /* When */
        model.back()

        /* Then */
        assertEquals(ClientMessage.AskCancel("r-1"), link.sent.last())
        assertEquals(AskStep.Compose("wrap the key bar", thinking = false, problem = null), model.state.value)
    }

    @Test
    fun `a result for a cancelled call is ignored`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()
        model.back()

        /* When */
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Confident("s-9", "switchboard")))

        /* Then */
        assertEquals(emptyList<Pair<String, String>>(), events.started)
    }

    @Test
    fun `leaving Ask Patch while it thinks cancels the call`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()

        /* When */
        model.close()

        /* Then */
        assertEquals(ClientMessage.AskCancel("r-1"), link.sent.last())
    }

    @Test
    fun `back from the ask box closes Ask Patch`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.back()

        /* Then */
        assertEquals(1, events.closed)
    }

    @Test
    fun `back from the project list returns to Patch's guesses`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.Unsure(listOf(AskCandidate(patch, "patch", null)), "Make it wrap.")))
        val pick = model.state.value
        model.anotherProject()

        /* When */
        model.back()

        /* Then */
        assertEquals(pick, model.state.value)
    }

    @Test
    fun `picking the project myself skips routing`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.type("wrap the key bar")

        /* When */
        model.pickProjectMyself()

        /* Then */
        val step = model.state.value as AskStep.Projects
        assertEquals(ProjectsReason.OwnPick, step.reason)
        assertEquals("wrap the key bar", step.prompt)
        assertEquals(listOf<ClientMessage>(ClientMessage.ListProjects), link.sent)
    }

    @Test
    fun `an error starting the session is shown on the list`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = askedModel()
        link.macSays(ServerMessage.AskResult("r-1", PhoneAskResult.NoMatch("No idea.")))
        model.start(switchboard)

        /* When */
        link.macSays(ServerMessage.AskError("r-2", "That project can’t be started from the phone"))

        /* Then */
        val step = model.state.value as AskStep.Projects
        assertEquals(AskProblem.Mac("That project can’t be started from the phone"), step.problem)
        assertEquals(null, step.starting)
    }

    @Test
    fun `asking while disconnected says so`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        link.state.value = LinkState.Reconnecting
        model.type("wrap the key bar")

        /* When */
        model.ask()

        /* Then */
        assertEquals(AskProblem.NotConnected, (model.state.value as AskStep.Compose).problem)
        assertTrue(link.sent.isEmpty())
    }

    @Test
    fun `a project path reads as its folder under a home-relative parent`() {
        /* Given */
        val path = "/Users/joris/Development/JBlaak/switchboard"

        /* When */
        val folder = folderOf(path)
        val parent = parentLabelOf(path)

        /* Then */
        assertEquals("switchboard", folder)
        assertEquals("~/Development/JBlaak", parent)
    }

    private class RecordingEvents : AskModel.Events {
        val started = mutableListOf<Pair<String, String>>()
        var closed = 0

        override fun askSessionStarted(sessionId: String, project: String) {
            started += sessionId to project
        }

        override fun askClosed() {
            closed++
        }
    }
}
