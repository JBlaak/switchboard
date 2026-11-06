package dev.jblaak.switchboard.ui.questions

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.protocol.AnsweredOn
import dev.jblaak.switchboard.protocol.Choice
import dev.jblaak.switchboard.protocol.Choices
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.GrillAnswer
import dev.jblaak.switchboard.protocol.GrillMark
import dev.jblaak.switchboard.protocol.GrillQuestionView
import dev.jblaak.switchboard.protocol.GrillSendState
import dev.jblaak.switchboard.protocol.GrillView
import dev.jblaak.switchboard.protocol.QuestionsOutcome
import dev.jblaak.switchboard.protocol.QuestionsSource
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.connected.FakePhoneLink
import dev.jblaak.switchboard.ui.connected.pendingQuestions
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GrillSheetModelTest {

    private val link = FakePhoneLink()
    private val views = MutableStateFlow<List<GrillView>>(emptyList())
    private val set = pendingQuestions("s-1", toolUseId = "grill-b-1", source = QuestionsSource.Grill)

    private fun TestScope.newModel(view: GrillView? = round()): GrillSheetModel {
        views.value = listOfNotNull(view)
        return GrillSheetModel(link, views, set, backgroundScope)
    }

    private fun lastAnswerSent(): ClientMessage.GrillAnswerGiven = link.sent.filterIsInstance<ClientMessage.GrillAnswerGiven>().last()

    @Test
    fun `the sheet shows the round's view from the Mac`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(view = null)

        /* When */
        views.value = listOf(round())

        /* Then */
        assertEquals("Where the drafts live", model.state.value.question?.title)
        assertEquals(0, model.state.value.place)
    }

    @Test
    fun `yes accepts the recommendation, sends it and moves on`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.accept()

        /* Then */
        assertEquals(ClientMessage.GrillAnswerGiven("s-1", "b-1", revision = 0, place = 0, answer = GrillAnswer.Accepted), lastAnswerSent())
        assertEquals(1, model.state.value.place)
        assertEquals(GrillAnswer.Accepted, model.state.value.answerAt(0))
    }

    @Test
    fun `picking the recommended choice accepts it`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.goTo(1)

        /* When */
        model.pick("b")

        /* Then */
        assertEquals(GrillAnswer.Accepted, lastAnswerSent().answer)
        assertEquals("b", model.state.value.pickedChoice(1))
    }

    @Test
    fun `picking another choice answers with its letter and words`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.goTo(1)

        /* When */
        model.pick("a")

        /* Then */
        assertEquals(GrillAnswer.Overridden("(a) Forever"), lastAnswerSent().answer)
        assertEquals("a", model.state.value.pickedChoice(1))
    }

    @Test
    fun `a note goes with the recommendation`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.open(GrillFieldKind.Note)

        /* When */
        model.type("keep it behind a flag")
        model.commit()

        /* Then */
        assertEquals(GrillAnswer.Noted("keep it behind a flag"), lastAnswerSent().answer)
        assertNull(model.state.value.field)
        assertEquals(1, model.state.value.place)
    }

    @Test
    fun `an empty note accepts the recommendation`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.open(GrillFieldKind.Note)

        /* When */
        model.commit()

        /* Then */
        assertEquals(GrillAnswer.Accepted, lastAnswerSent().answer)
    }

    @Test
    fun `answer instead sends the user's own words`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.open(GrillFieldKind.Instead)

        /* When */
        model.type("In the renderer")
        model.commit()

        /* Then */
        assertEquals(GrillAnswer.Overridden("In the renderer"), lastAnswerSent().answer)
    }

    @Test
    fun `an empty own answer sends nothing`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.open(GrillFieldKind.Instead)

        /* When */
        model.commit()

        /* Then */
        assertTrue(link.sent.isEmpty())
        assertEquals(0, model.state.value.place)
    }

    @Test
    fun `reopening a note starts from the note given`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Noted("small"), null, null)))

        /* When */
        model.open(GrillFieldKind.Note)

        /* Then */
        assertEquals(GrillField(GrillFieldKind.Note, "small"), model.state.value.field)
    }

    @Test
    fun `skip moves on without answering`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.skip()

        /* Then */
        assertEquals(1, model.state.value.place)
        assertTrue(link.sent.isEmpty())
        assertNull(model.state.value.answerAt(0))
    }

    @Test
    fun `skipping the last question opens the review`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.goTo(2)

        /* When */
        model.skip()

        /* Then */
        assertTrue(model.state.value.onReview)
        assertNull(model.state.value.question)
    }

    @Test
    fun `ask about this sends the question and shows Claude answering`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.open(GrillFieldKind.Ask)
        model.type("Why not the renderer?")

        /* When */
        model.commit()

        /* Then */
        assertEquals(ClientMessage.GrillAsk("s-1", "b-1", 0, 0, "Why not the renderer?"), link.sent.single())
        assertTrue(model.state.value.isAsking(0))
        assertEquals(0, model.state.value.place)
    }

    @Test
    fun `wait, what asks without text`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.waitWhat()

        /* Then */
        assertEquals(ClientMessage.GrillAsk("s-1", "b-1", 0, 0, null), link.sent.single())
    }

    @Test
    fun `the review text is what Claude will receive`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Accepted, GrillAnswer.Overridden("(a)  Forever\n and ever"), null)))

        /* When */
        model.goTo(2)
        model.open(GrillFieldKind.Note)
        model.type("  sync it\nall ")
        model.commit()

        /* Then */
        assertEquals("Q1: yes\nQ2: (a) Forever and ever\nQ4: yes, note: sync it all", model.state.value.reviewText)
    }

    @Test
    fun `an answer given here shows until a view does`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.accept()

        /* When */
        views.value = listOf(round(answers = listOf(GrillAnswer.Accepted, null, null), agentsRunning = 1))

        /* Then */
        assertTrue(model.state.value.given.isEmpty())
        assertEquals(GrillAnswer.Accepted, model.state.value.answerAt(0))
    }

    @Test
    fun `the Mac's answer from elsewhere wins once views move on`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.accept()

        /* When */
        views.value = listOf(round(answers = listOf(null, null, null), agentsRunning = 1))
        views.value = listOf(round(answers = listOf(GrillAnswer.Overridden("Mac's"), null, null), agentsRunning = 2))

        /* Then */
        assertEquals(GrillAnswer.Overridden("Mac's"), model.state.value.answerAt(0))
    }

    @Test
    fun `with nothing answered there is nothing to send`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.goTo(3)

        /* When */
        model.send()

        /* Then */
        assertEquals(GrillSendBar.Ready(count = 0), model.state.value.sendBar)
        assertFalse(model.state.value.canSend)
        assertTrue(link.sent.isEmpty())
    }

    @Test
    fun `with no agents running the review sends the answers`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Accepted, null, GrillAnswer.Accepted)))
        model.goTo(3)

        /* When */
        model.send()

        /* Then */
        assertEquals(ClientMessage.GrillSend("s-1", "b-1"), link.sent.single())
        assertEquals(GrillPhase.Sending, model.state.value.phase)
    }

    @Test
    fun `the review counts the answers it sends`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Accepted, null, GrillAnswer.Accepted)))

        /* When */
        model.goTo(3)

        /* Then */
        assertEquals(GrillSendBar.Ready(count = 2), model.state.value.sendBar)
    }

    @Test
    fun `while agents run the review offers to send when research is done`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Accepted, null, null), agentsRunning = 2))
        model.goTo(3)

        /* When */
        model.queue()

        /* Then */
        assertEquals(ClientMessage.GrillQueue("s-1", "b-1"), link.sent.single())
        assertEquals(GrillSendBar.Queued, model.state.value.sendBar)
    }

    @Test
    fun `while agents run with nothing answered neither send is enabled`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(agentsRunning = 2))

        /* When */
        model.goTo(3)

        /* Then */
        assertEquals(GrillSendBar.ResearchRunning(enabled = false), model.state.value.sendBar)
    }

    @Test
    fun `a queued send can be cancelled`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Accepted, null, null), agentsRunning = 2, send = GrillSendState.Queued))
        model.goTo(3)

        /* When */
        model.cancelQueue()

        /* Then */
        assertEquals(ClientMessage.GrillCancelQueue("s-1", "b-1"), link.sent.single())
        assertEquals(GrillSendBar.ResearchRunning(enabled = true), model.state.value.sendBar)
    }

    @Test
    fun `the Mac refusing a send shows its words and lets it be tried again`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Accepted, null, null)))
        model.goTo(3)
        model.send()

        /* When */
        link.macSays(ServerMessage.GrillError("s-1", "b-1", "Claude is busy; send once it stops"))

        /* Then */
        assertEquals(GrillError.FromMac("Claude is busy; send once it stops"), model.state.value.error)
        assertEquals(GrillPhase.Answering, model.state.value.phase)
        assertTrue(model.state.value.canSend)
    }

    @Test
    fun `an answer that cannot reach the Mac stays on the question`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        link.state.value = LinkState.Reconnecting

        /* When */
        model.accept()

        /* Then */
        assertEquals(GrillError.NotConnected, model.state.value.error)
        assertEquals(0, model.state.value.place)
        assertNull(model.state.value.answerAt(0))
    }

    @Test
    fun `the round closing after this phone sent it closes the sheet`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel(round(answers = listOf(GrillAnswer.Accepted, null, null)))
        model.goTo(3)
        model.send()

        /* When */
        views.value = emptyList()

        /* Then */
        assertEquals(GrillPhase.Done, model.state.value.phase)
    }

    @Test
    fun `the round closing on its own shows it was answered on the Mac`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        views.value = emptyList()

        /* Then */
        assertEquals(GrillPhase.AnsweredElsewhere(AnsweredOn.Mac), model.state.value.phase)
    }

    @Test
    fun `a withdrawn round goes away`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        link.macSays(ServerMessage.QuestionsSettled("s-1", "grill-b-1", QuestionsOutcome.Withdrawn, null))

        /* Then */
        assertEquals(GrillPhase.Withdrawn, model.state.value.phase)
    }

    @Test
    fun `a first round shows no banner`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        val state = model.state.value

        /* Then */
        assertNull(state.revisionBanner)
        assertFalse(state.showsNotSent)
    }

    @Test
    fun `a revision shows what it changed`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        views.value = listOf(revised())

        /* Then */
        assertEquals(RevisionCounts(changed = 1, added = 1, dropped = 1), model.state.value.revisionBanner)
    }

    @Test
    fun `the banner goes once every marked question was looked at`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        views.value = listOf(revised())

        /* When */
        model.goTo(1)
        model.goTo(2)

        /* Then */
        assertNull(model.state.value.revisionBanner)
    }

    @Test
    fun `the banner can be dismissed`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        views.value = listOf(revised())

        /* When */
        model.dismissBanner()

        /* Then */
        assertNull(model.state.value.revisionBanner)
    }

    @Test
    fun `a revision that cancelled a queued send says it was not sent`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        views.value = listOf(revised().copy(send = GrillSendState.Unsent))

        /* Then */
        assertTrue(model.state.value.showsNotSent)
        assertNull(model.state.value.revisionBanner)
    }

    @Test
    fun `a revision keeps the place on the question it still asks`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.goTo(2)

        /* When */
        views.value = listOf(revised())

        /* Then */
        assertEquals("Syncing to the phone!", model.state.value.question?.title)
    }

    @Test
    fun `answers go against the revision shown`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        views.value = listOf(revised())

        /* When */
        model.accept()

        /* Then */
        assertEquals(1, lastAnswerSent().revision)
    }

    private fun question(number: Int, title: String, answer: GrillAnswer?, choices: Choices? = null, mark: GrillMark? = null) =
        GrillQuestionView(
            number = number,
            title = title,
            reason = "Because.",
            recommendation = if (choices != null) "(b) Until the round closes." else "Do the simple thing.",
            choices = choices,
            recommendedChoice = if (choices != null) "b" else null,
            answer = answer,
            setAside = null,
            mark = mark,
            asked = false,
            explanation = null,
        )

    private val keepChoices = Choices(
        lead = "Drafts cost little.",
        list = listOf(Choice("a", "Forever"), Choice("b", "Until the round closes")),
        after = "",
    )

    private fun round(
        answers: List<GrillAnswer?> = listOf(null, null, null),
        agentsRunning: Int = 0,
        send: GrillSendState = GrillSendState.Idle,
    ) = GrillView(
        sessionId = "s-1",
        roundId = "b-1",
        revision = 0,
        preamble = "",
        questions = listOf(
            question(1, "Where the drafts live", answers[0]),
            question(2, "How long to keep a draft", answers[1], keepChoices),
            question(4, "Syncing to the phone", answers[2]),
        ),
        dropped = 0,
        agentsRunning = agentsRunning,
        send = send,
        asking = null,
    )

    /** Q2 changed, Q4 kept (its title re-punctuated) and moved, Q1 dropped, Q5 new. */
    private fun revised() = GrillView(
        sessionId = "s-1",
        roundId = "b-1",
        revision = 1,
        preamble = "The agents are back.",
        questions = listOf(
            question(2, "How long to keep a draft", null, keepChoices, mark = GrillMark.Changed),
            question(5, "Who sees the drafts", null, mark = GrillMark.New),
            question(4, "Syncing to the phone!", null),
        ),
        dropped = 1,
        agentsRunning = 0,
        send = GrillSendState.Idle,
        asking = null,
    )
}
