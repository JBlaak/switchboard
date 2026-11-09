package dev.jblaak.switchboard.ui.questions

import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.AnsweredOn
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.GrillAnswer
import dev.jblaak.switchboard.protocol.GrillMark
import dev.jblaak.switchboard.protocol.GrillQuestionView
import dev.jblaak.switchboard.protocol.GrillSendState
import dev.jblaak.switchboard.protocol.GrillView
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.QuestionsOutcome
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.connected.PhoneLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Answering a grilling round from the phone, one question at a time, as the Mac's grilling card does.
 *
 * The draft answers are the Mac's: every answer goes to it as it is given (`grill-answer`), and the sheet shows
 * what the next `grill` view says. Until that view arrives the answer just given is shown as given, so a tap
 * never looks lost. Where the phone is in the round (which question, an open text field, a dismissed banner) is
 * this phone's own.
 *
 * The round closes when its answers are sent, here or on the Mac, or when the user replies in the terminal; the
 * Mac then stops listing its view.
 */
class GrillSheetModel(
    private val link: PhoneLink,
    views: StateFlow<List<GrillView>>,
    set: PendingQuestions,
    scope: CoroutineScope,
) {

    private val roundId = roundIdOf(set)
    private val toolUseId = set.toolUseId

    private val mutableState = MutableStateFlow(GrillSheetState(view = null))
    val state: StateFlow<GrillSheetState> = mutableState.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            views.collect { list -> viewArrived(list.firstOrNull { it.roundId == roundId }) }
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.messages.collect { receive(it) }
        }
    }

    /** "Yes, go with that": Claude's recommendation, and on to the next question. */
    fun accept() = answer(GrillAnswer.Accepted)

    /** A lettered choice: the recommended one is accepting it, another answers with its own words, `(b) 30 days`. */
    fun pick(letter: String) {
        val question = mutableState.value.question ?: return
        val choice = question.choices?.list?.firstOrNull { it.letter == letter } ?: return
        answer(if (letter == question.recommendedChoice) GrillAnswer.Accepted else GrillAnswer.Overridden("(${choice.letter}) ${choice.text}"))
    }

    /** Opens the text field under the buttons: a note (prefilled with the note given), an own answer, or an ask. */
    fun open(field: GrillFieldKind) {
        mutableState.update { current ->
            val given = current.answerAt(current.place)
            val text = when {
                field == GrillFieldKind.Note && given is GrillAnswer.Noted -> given.note
                field == GrillFieldKind.Instead && given is GrillAnswer.Overridden -> given.text
                else -> ""
            }
            current.copy(field = GrillField(field, text))
        }
    }

    fun type(text: String) {
        mutableState.update { current -> current.field?.let { current.copy(field = it.copy(text = text)) } ?: current }
    }

    fun closeField() {
        mutableState.update { it.copy(field = null) }
    }

    /**
     * The open field's Next (or Ask): an empty note accepts the recommendation, an empty own answer or ask does
     * nothing but close the field.
     */
    fun commit() {
        val current = mutableState.value
        val field = current.field ?: return
        val text = field.text.trim()
        when (field.kind) {
            GrillFieldKind.Note -> answer(if (text.isEmpty()) GrillAnswer.Accepted else GrillAnswer.Noted(text))
            GrillFieldKind.Instead -> if (text.isEmpty()) closeField() else answer(GrillAnswer.Overridden(text))
            GrillFieldKind.Ask -> {
                closeField()
                if (text.isNotEmpty()) ask(text)
            }
        }
    }

    /** Wait, what?: has Claude re-pitch the question in plain words. */
    fun waitWhat() = ask(null)

    /** On to the next question, leaving this one as it is. */
    fun skip() = goTo(mutableState.value.place + 1)

    fun back() = goTo(mutableState.value.place - 1)

    /**
     * A sideways swipe: the previous question, or the next as Skip does (the review after the last). Not while a
     * text field is open, so a swipe never throws away what is being typed.
     */
    fun swipe(to: QuestionSwipe) {
        val current = mutableState.value
        if (current.field != null || current.phase != GrillPhase.Answering) return
        when (to) {
            QuestionSwipe.Previous -> back()
            QuestionSwipe.Next -> skip()
        }
    }

    /** [place] past the last question is the review. */
    fun goTo(place: Int) {
        mutableState.update { current ->
            val size = current.view?.questions?.size ?: return@update current
            val to = place.coerceIn(0, size)
            current.copy(place = to, field = null, seen = current.seen + to)
        }
    }

    fun dismissBanner() {
        mutableState.update { it.copy(bannerDismissed = true) }
    }

    /** Types the answers into the session now. */
    fun send() {
        val current = mutableState.value
        val view = current.view ?: return
        if (!current.canSend) return
        val outcome = link.send(ClientMessage.GrillSend(view.sessionId, view.roundId))
        mutableState.update {
            if (outcome == SendOutcome.Sent) it.copy(phase = GrillPhase.Sending, error = null) else it.copy(error = GrillError.NotConnected)
        }
    }

    /** Sends the answers once the session's research agents are done. */
    fun queue() {
        val current = mutableState.value
        val view = current.view ?: return
        if (!current.canSend) return
        sendOptimistically(ClientMessage.GrillQueue(view.sessionId, view.roundId)) { it.copy(sendShown = GrillSendState.Queued) }
    }

    fun cancelQueue() {
        val view = mutableState.value.view ?: return
        sendOptimistically(ClientMessage.GrillCancelQueue(view.sessionId, view.roundId)) { it.copy(sendShown = GrillSendState.Idle) }
    }

    fun errorSeen() {
        mutableState.update { it.copy(error = null) }
    }

    private fun answer(answer: GrillAnswer) {
        val current = mutableState.value
        val view = current.view ?: return
        if (current.place !in view.questions.indices) return
        val place = current.place
        val outcome = link.send(ClientMessage.GrillAnswerGiven(view.sessionId, view.roundId, view.revision, place, answer))
        if (outcome != SendOutcome.Sent) {
            mutableState.update { it.copy(error = GrillError.NotConnected) }
            return
        }
        mutableState.update { it.copy(given = it.given + (place to Given(answer, viewsSince = 0)), error = null) }
        goTo(place + 1)
    }

    /** [text] null is Wait, what?. */
    private fun ask(text: String?) {
        val current = mutableState.value
        val view = current.view ?: return
        if (current.place !in view.questions.indices) return
        val place = current.place
        sendOptimistically(ClientMessage.GrillAsk(view.sessionId, view.roundId, view.revision, place, text)) {
            it.copy(askingShown = place)
        }
    }

    private fun sendOptimistically(message: ClientMessage, shown: (GrillSheetState) -> GrillSheetState) {
        val outcome = link.send(message)
        mutableState.update { if (outcome == SendOutcome.Sent) shown(it).copy(error = null) else it.copy(error = GrillError.NotConnected) }
    }

    private fun viewArrived(view: GrillView?) {
        mutableState.update { current ->
            when {
                view == null && current.view == null -> current
                view == null -> current.copy(phase = closedPhase(current))
                else -> current.withView(view)
            }
        }
    }

    private fun closedPhase(current: GrillSheetState): GrillPhase = when (current.phase) {
        GrillPhase.Sending -> GrillPhase.Done
        GrillPhase.Answering -> GrillPhase.AnsweredElsewhere(AnsweredOn.Mac)
        else -> current.phase
    }

    private fun receive(message: ServerMessage) {
        when (message) {
            is ServerMessage.GrillError -> if (message.roundId == roundId) {
                mutableState.update {
                    it.copy(
                        error = GrillError.FromMac(message.error),
                        phase = if (it.phase == GrillPhase.Sending) GrillPhase.Answering else it.phase,
                        given = emptyMap(),
                        sendShown = null,
                        askingShown = null,
                    )
                }
            }
            is ServerMessage.QuestionsSettled -> if (message.toolUseId == toolUseId) settled(message)
            else -> Unit
        }
    }

    private fun settled(message: ServerMessage.QuestionsSettled) {
        mutableState.update { current ->
            when {
                current.phase != GrillPhase.Answering -> current
                message.outcome == QuestionsOutcome.Withdrawn -> current.copy(phase = GrillPhase.Withdrawn)
                else -> current.copy(phase = GrillPhase.AnsweredElsewhere(message.answeredOn ?: AnsweredOn.Mac))
            }
        }
    }

    companion object {
        /** A grilling round's pending set is `grill-<roundId>`. */
        fun roundIdOf(set: PendingQuestions): String = set.toolUseId.removePrefix("grill-")
    }
}

/** An answer this phone gave that no view has shown yet; [viewsSince] counts the views that came meanwhile. */
data class Given(val answer: GrillAnswer, val viewsSince: Int)

enum class GrillFieldKind { Note, Instead, Ask }

data class GrillField(val kind: GrillFieldKind, val text: String)

sealed interface GrillError {
    /** The link is down: nothing went to the Mac. */
    data object NotConnected : GrillError

    /** The Mac's words: "Answer a question first", "Claude is busy; send once it stops". */
    data class FromMac(val text: String) : GrillError
}

sealed interface GrillPhase {
    data object Answering : GrillPhase

    /** Send went to the Mac; the sheet closes once the round does. */
    data object Sending : GrillPhase

    /** This phone's send went in. */
    data object Done : GrillPhase

    /** Sent on the Mac, or answered in the terminal. */
    data class AnsweredElsewhere(val on: AnsweredOn) : GrillPhase

    /** The session went away. */
    data object Withdrawn : GrillPhase
}

/** What the review's footer offers, from the round's send state and its research agents. */
sealed interface GrillSendBar {
    /** Waiting for the agents: only cancelling. */
    data object Queued : GrillSendBar

    /** Agents are still running: When research is done, or Send now. */
    data class ResearchRunning(val enabled: Boolean) : GrillSendBar

    /** Back, or Send [count] answers. */
    data class Ready(val count: Int) : GrillSendBar
}

/** The revision banner's counts: "Claude revised the round: 1 changed, 1 new, 1 dropped." */
data class RevisionCounts(val changed: Int, val added: Int, val dropped: Int)

data class GrillSheetState(
    /** The round as the Mac last showed it; null until its first view arrives. */
    val view: GrillView?,
    /** The question shown; the questions' count is the review. */
    val place: Int = 0,
    val field: GrillField? = null,
    /** Answers given here per place, against the current revision, until a view shows them. */
    val given: Map<Int, Given> = emptyMap(),
    /** The send state just asked for, until the next view says. */
    val sendShown: GrillSendState? = null,
    /** The place just asked about, until the next view says. */
    val askingShown: Int? = null,
    /** Places looked at since the last revision; the banner goes once every marked one was. */
    val seen: Set<Int> = setOf(0),
    val bannerDismissed: Boolean = false,
    val phase: GrillPhase = GrillPhase.Answering,
    val error: GrillError? = null,
) {
    val questions: List<GrillQuestionView> get() = view?.questions.orEmpty()

    val onReview: Boolean get() = view != null && place >= questions.size

    /** The question shown; null on the review and before the first view. */
    val question: GrillQuestionView? get() = questions.getOrNull(place)

    /** What the question at [place] is answered with, as given here or as the Mac last said. */
    fun answerAt(place: Int): GrillAnswer? = given[place]?.answer ?: questions.getOrNull(place)?.answer

    val answeredCount: Int get() = questions.indices.count { answerAt(it) != null }

    /** The choice that shows as picked: the recommended one for an accepted answer, the one an own answer opens with. */
    fun pickedChoice(place: Int): String? {
        val question = questions.getOrNull(place) ?: return null
        val letters = question.choices?.list?.map { it.letter } ?: return null
        return when (val answer = answerAt(place)) {
            null -> null
            is GrillAnswer.Accepted, is GrillAnswer.Noted -> question.recommendedChoice
            is GrillAnswer.Overridden -> choiceLetterOf(answer.text)?.takeIf { it in letters }
        }
    }

    fun isAsking(place: Int): Boolean = (askingShown ?: view?.asking) == place

    val sendState: GrillSendState get() = sendShown ?: view?.send ?: GrillSendState.Idle

    /** Exactly the text Claude will receive. */
    val reviewText: String get() = answersPrompt(questions.mapIndexed { place, question -> question.number to answerAt(place) })

    val canSend: Boolean get() = answeredCount > 0 && phase == GrillPhase.Answering

    val sendBar: GrillSendBar
        get() = when {
            sendState == GrillSendState.Queued -> GrillSendBar.Queued
            (view?.agentsRunning ?: 0) > 0 -> GrillSendBar.ResearchRunning(enabled = canSend)
            else -> GrillSendBar.Ready(answeredCount)
        }

    /** "Not sent: Claude changed the round…": a revision cancelled a queued send. */
    val showsNotSent: Boolean get() = sendState == GrillSendState.Unsent

    /** The revision banner, until dismissed or every marked question was looked at; the not-sent alert outranks it. */
    val revisionBanner: RevisionCounts?
        get() {
            val view = view ?: return null
            if (view.revision == 0 || bannerDismissed || showsNotSent) return null
            val marked = view.questions.indices.filter { view.questions[it].mark != null }
            if (marked.isEmpty() && view.dropped == 0) return null
            if (marked.isNotEmpty() && marked.all { it in seen }) return null
            return RevisionCounts(
                changed = view.questions.count { it.mark == GrillMark.Changed },
                added = view.questions.count { it.mark == GrillMark.New },
                dropped = view.dropped,
            )
        }

    /** The next view from the Mac: answers it shows are no longer this phone's to hold, and a revision moves the place. */
    fun withView(next: GrillView): GrillSheetState {
        val previous = view
        if (previous != null && next.revision != previous.revision) {
            val place = placeAfterRevision(previous, next, place)
            return copy(
                view = next,
                place = place,
                field = if (place == this.place) field else null,
                given = emptyMap(),
                sendShown = null,
                askingShown = null,
                seen = setOf(place),
                bannerDismissed = false,
            )
        }
        val stillGiven = given.mapNotNull { (place, given) ->
            when {
                next.questions.getOrNull(place)?.answer == given.answer -> null
                given.viewsSince >= 1 -> null
                else -> place to given.copy(viewsSince = given.viewsSince + 1)
            }
        }.toMap()
        return copy(
            view = next,
            place = place.coerceAtMost(next.questions.size),
            given = stillGiven,
            sendShown = null,
            askingShown = null,
        )
    }
}

/** The question a revision made of the one at [place]: the same title if it still asks it, else the same place. */
internal fun placeAfterRevision(from: GrillView, to: GrillView, place: Int): Int {
    if (place >= from.questions.size) return to.questions.size
    val title = normalisedTitle(from.questions[place].title)
    val same = to.questions.indexOfFirst { normalisedTitle(it.title) == title }
    return if (same >= 0) same else place.coerceAtMost((to.questions.size - 1).coerceAtLeast(0))
}

/** Lowercase, punctuation and symbols to spaces, spaces collapsed: as the Mac matches questions across revisions. */
internal fun normalisedTitle(title: String): String =
    title.lowercase().replace(Regex("""[^\p{L}\p{N}]+"""), " ").trim()

/** `(b) 30 days` → `b`. */
internal fun choiceLetterOf(text: String): String? = Regex("""^\((\w)\)""").find(text.trim())?.groupValues?.get(1)

/**
 * The prompt that answers a round, as `answersPrompt` in `src/domain/grill/reply.ts` writes it: a `Q<n>: …` line
 * per answered question, in the round's own numbering; unanswered ones left out. '' when nothing is answered.
 */
fun answersPrompt(questions: List<Pair<Int, GrillAnswer?>>): String =
    questions.mapNotNull { (number, answer) -> answer?.let { "Q$number: ${answerText(it)}" } }.joinToString("\n")

/** One answer as it goes on its line, after `Q<n>: `. */
fun answerText(answer: GrillAnswer): String = when (answer) {
    is GrillAnswer.Accepted -> "yes"
    is GrillAnswer.Noted -> "yes, note: ${oneLine(answer.note)}"
    is GrillAnswer.Overridden -> oneLine(answer.text)
}

private fun oneLine(text: String): String = text.trim().replace(Regex("""\s+"""), " ")
