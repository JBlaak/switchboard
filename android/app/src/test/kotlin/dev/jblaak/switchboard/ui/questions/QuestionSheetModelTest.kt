package dev.jblaak.switchboard.ui.questions

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.protocol.AnsweredOn
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.QuestionsOutcome
import dev.jblaak.switchboard.protocol.QuestionsSource
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.connected.FakePhoneLink
import dev.jblaak.switchboard.ui.connected.pendingQuestions
import dev.jblaak.switchboard.ui.connected.question
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class QuestionSheetModelTest {

    private val link = FakePhoneLink()

    private val twoQuestions = pendingQuestions(
        "s-1",
        questions = listOf(
            question("Which transport?", false, "WebSocket (Recommended)", "HTTP"),
            question("Which screens?", true, "Sessions", "Terminal", "Questions"),
        ),
    )

    private fun TestScope.newModel(set: PendingQuestions = twoQuestions) = QuestionSheetModel(link, set, backgroundScope)

    private fun answerSent(): ClientMessage.Answer = link.sent.filterIsInstance<ClientMessage.Answer>().single()

    @Test
    fun `answering every question sends them together`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.pick("WebSocket (Recommended)")
        model.next()
        model.pick("Sessions")
        model.next()

        /* Then */
        assertEquals(
            ClientMessage.Answer(
                "s-1",
                "toolu_1",
                mapOf("Which transport?" to "WebSocket (Recommended)", "Which screens?" to "Sessions"),
            ),
            answerSent(),
        )
    }

    @Test
    fun `a multi-select answer joins the picks in the options' order`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.pick("HTTP")
        model.next()

        /* When */
        model.pick("Questions")
        model.pick("Sessions")
        model.next()

        /* Then */
        assertEquals("Sessions, Questions", answerSent().answers["Which screens?"])
    }

    @Test
    fun `picking a multi-select option twice takes it back`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.pick("HTTP")
        model.next()

        /* When */
        model.pick("Terminal")
        model.pick("Terminal")

        /* Then */
        assertEquals(emptyList<String>(), model.state.value.draft.picked)
    }

    @Test
    fun `own words replace a picked option`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.pick("HTTP")

        /* When */
        model.type("Server-sent events")

        /* Then */
        assertEquals("Server-sent events", answerOf(model.state.value.question, model.state.value.draft))
        assertEquals(emptyList<String>(), model.state.value.draft.picked)
    }

    @Test
    fun `an unanswered question holds the sheet on it`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.next()

        /* Then */
        assertEquals(0, model.state.value.step)
        assertFalse(model.state.value.canGoOn)
    }

    @Test
    fun `back returns to the previous question with its answer`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.pick("HTTP")
        model.next()

        /* When */
        model.back()

        /* Then */
        assertEquals(0, model.state.value.step)
        assertEquals(listOf("HTTP"), model.state.value.draft.picked)
    }

    @Test
    fun `the Mac taking the answer closes the sheet`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(pendingQuestions("s-1"))
        model.pick("HTTP")
        model.next()

        /* When */
        link.macSays(ServerMessage.QuestionsSettled("s-1", "toolu_1", QuestionsOutcome.Answered, AnsweredOn.Phone))
        link.macSays(ServerMessage.AnswerResult("s-1", "toolu_1", ok = true))

        /* Then */
        assertEquals(QuestionPhase.Done, model.state.value.phase)
    }

    @Test
    fun `an answer on the Mac first shows answered on Mac`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        link.macSays(ServerMessage.QuestionsSettled("s-1", "toolu_1", QuestionsOutcome.Answered, AnsweredOn.Mac))

        /* Then */
        assertEquals(QuestionPhase.AnsweredElsewhere(AnsweredOn.Mac), model.state.value.phase)
    }

    @Test
    fun `the Mac answering while this phone's answer is on its way still shows answered on Mac`() =
        runTest(UnconfinedTestDispatcher()) {
            /* Given */
            val model = newModel(pendingQuestions("s-1"))
            model.pick("HTTP")
            model.next()

            /* When */
            link.macSays(ServerMessage.QuestionsSettled("s-1", "toolu_1", QuestionsOutcome.Answered, AnsweredOn.Mac))
            link.macSays(ServerMessage.AnswerResult("s-1", "toolu_1", ok = false, error = "Not pending"))

            /* Then */
            assertEquals(QuestionPhase.AnsweredElsewhere(AnsweredOn.Mac), model.state.value.phase)
        }

    @Test
    fun `withdrawn questions go away`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        link.macSays(ServerMessage.QuestionsSettled("s-1", "toolu_1", QuestionsOutcome.Withdrawn, null))

        /* Then */
        assertEquals(QuestionPhase.Withdrawn, model.state.value.phase)
    }

    @Test
    fun `another set settling leaves this one be`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        link.macSays(ServerMessage.QuestionsSettled("s-1", "toolu_2", QuestionsOutcome.Answered, AnsweredOn.Mac))

        /* Then */
        assertEquals(QuestionPhase.Answering, model.state.value.phase)
    }

    @Test
    fun `a refused answer shows the Mac's error`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(pendingQuestions("s-1"))
        model.pick("HTTP")
        model.next()

        /* When */
        link.macSays(ServerMessage.AnswerResult("s-1", "toolu_1", ok = false, error = "The session is gone"))

        /* Then */
        assertEquals(QuestionPhase.Failed("The session is gone"), model.state.value.phase)
    }

    @Test
    fun `an answer that cannot be sent can be tried again`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(pendingQuestions("s-1"))
        link.state.value = LinkState.Reconnecting
        model.pick("HTTP")
        model.next()

        /* When */
        model.failureSeen()

        /* Then */
        assertEquals(QuestionPhase.Answering, model.state.value.phase)
    }

    @Test
    fun `a re-keyed session gets its answer under the new id`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(pendingQuestions("s-1"))
        link.macSays(ServerMessage.SessionRekeyed(from = "s-1", to = "s-2"))

        /* When */
        model.pick("HTTP")
        model.next()

        /* Then */
        assertEquals("s-2", answerSent().sessionId)
    }

    @Test
    fun `a grill round takes the recommendation with yes`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val grill = pendingQuestions(
            "s-1",
            source = QuestionsSource.Grill,
            questions = listOf(question("Where should the code live?", false, "Yes (Recommended)", "Wait, what?")),
        )
        val model = newModel(grill)

        /* When */
        model.acceptRecommendation()

        /* Then */
        assertEquals(mapOf("Where should the code live?" to "Yes (Recommended)"), answerSent().answers)
    }

    @Test
    fun `a skipped grill question goes back unanswered`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val grill = pendingQuestions(
            "s-1",
            source = QuestionsSource.Grill,
            questions = listOf(
                question("Q one?", false, "Yes (Recommended)", "Wait, what?"),
                question("Q two?", false, "Yes (Recommended)", "Wait, what?"),
            ),
        )
        val model = newModel(grill)

        /* When */
        model.skip()
        model.type("Somewhere else")
        model.next()

        /* Then */
        assertEquals(mapOf("Q two?" to "Somewhere else"), answerSent().answers)
    }

    @Test
    fun `the recommended mark is shown as a badge, not in the label`() {
        /* Given */
        val label = "WebSocket (Recommended)"

        /* When */
        val shown = displayLabelOf(label)

        /* Then */
        assertEquals("WebSocket", shown)
        assertEquals(true, isRecommended(label))
    }
}
