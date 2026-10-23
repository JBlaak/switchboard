package dev.jblaak.switchboard.ui.questions

import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.AnsweredOn
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.Question
import dev.jblaak.switchboard.protocol.QuestionsOutcome
import dev.jblaak.switchboard.protocol.QuestionsSource
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
 * Answering one set of questions, a question at a time: AskUserQuestion's options, multi-select and own words, or
 * a grilling round's recommendation. The answers go back together, and answering makes this phone the session's
 * active device (the Mac follows with `owner`).
 *
 * The first answer wins: when the Mac (or another phone) answers first, or the CLI gives up on the questions,
 * the sheet says so instead of sending.
 */
class QuestionSheetModel(
    private val link: PhoneLink,
    set: PendingQuestions,
    scope: CoroutineScope,
) {

    private val mutableState = MutableStateFlow(
        QuestionSheetState(
            set = set,
            step = 0,
            drafts = set.questions.map { Draft(picked = emptyList(), ownWords = "") },
            phase = QuestionPhase.Answering,
        ),
    )
    val state: StateFlow<QuestionSheetState> = mutableState.asStateFlow()

    /** Who settled the set while this phone's answer was on its way, which then comes back refused. */
    private var settledMeanwhile: AnsweredOn? = null

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.messages.collect { receive(it) }
        }
    }

    /** Single-select: [label] becomes the answer. Multi-select: [label] is toggled. */
    fun pick(label: String) {
        updateDraft { question, draft ->
            if (question.multiSelect) {
                draft.copy(picked = if (label in draft.picked) draft.picked - label else draft.picked + label)
            } else {
                Draft(picked = listOf(label), ownWords = "")
            }
        }
    }

    /** Own words; on a single-select question they replace a picked option. */
    fun type(text: String) {
        updateDraft { question, draft ->
            if (question.multiSelect || text.isBlank()) draft.copy(ownWords = text) else Draft(emptyList(), text)
        }
    }

    /** To the next question, or, on the last, sends every answer. */
    fun next() {
        val current = mutableState.value
        if (current.phase != QuestionPhase.Answering || !current.canGoOn) return
        if (current.isLastStep) submit() else mutableState.update { it.copy(step = it.step + 1) }
    }

    fun back() {
        mutableState.update { if (it.step > 0 && it.phase == QuestionPhase.Answering) it.copy(step = it.step - 1) else it }
    }

    /** A grilling round: leave this question unanswered and go on. */
    fun skip() {
        updateDraft { _, _ -> Draft(emptyList(), "") }
        next()
    }

    /** A grilling round: "Yes, go with that", and on. */
    fun acceptRecommendation() {
        val label = mutableState.value.question.options.firstOrNull()?.label ?: return
        pick(label)
        next()
    }

    /** After a failed send: back to the answers, to try again. */
    fun failureSeen() {
        mutableState.update { if (it.phase is QuestionPhase.Failed) it.copy(phase = QuestionPhase.Answering) else it }
    }

    private fun submit() {
        val current = mutableState.value
        val answers = current.set.questions.zip(current.drafts)
            .mapNotNull { (question, draft) -> answerOf(question, draft)?.let { question.question to it } }
            .toMap()
        settledMeanwhile = null
        val outcome = link.send(ClientMessage.Answer(current.set.sessionId, current.set.toolUseId, answers))
        mutableState.update {
            it.copy(phase = if (outcome == SendOutcome.Sent) QuestionPhase.Sending else QuestionPhase.Failed(null))
        }
    }

    private fun receive(message: ServerMessage) {
        val set = mutableState.value.set
        when (message) {
            is ServerMessage.SessionRekeyed -> if (message.from == set.sessionId) {
                mutableState.update { it.copy(set = it.set.copy(sessionId = message.to)) }
            }
            is ServerMessage.QuestionsSettled -> if (message.toolUseId == set.toolUseId) settled(message)
            is ServerMessage.AnswerResult -> if (message.toolUseId == set.toolUseId) answered(message)
            else -> Unit
        }
    }

    private fun settled(message: ServerMessage.QuestionsSettled) {
        val phase = mutableState.value.phase
        if (phase == QuestionPhase.Sending) {
            if (message.answeredOn != AnsweredOn.Phone) settledMeanwhile = message.answeredOn ?: AnsweredOn.Mac
            return
        }
        if (phase == QuestionPhase.Done) return
        val settledPhase = when (message.outcome) {
            QuestionsOutcome.Withdrawn -> QuestionPhase.Withdrawn
            QuestionsOutcome.Answered -> QuestionPhase.AnsweredElsewhere(message.answeredOn ?: AnsweredOn.Mac)
        }
        mutableState.update { it.copy(phase = settledPhase) }
    }

    private fun answered(message: ServerMessage.AnswerResult) {
        if (mutableState.value.phase != QuestionPhase.Sending) return
        val elsewhere = settledMeanwhile
        val phase = when {
            message.ok -> QuestionPhase.Done
            elsewhere != null -> QuestionPhase.AnsweredElsewhere(elsewhere)
            else -> QuestionPhase.Failed(message.error)
        }
        mutableState.update { it.copy(phase = phase) }
    }

    private fun updateDraft(change: (Question, Draft) -> Draft) {
        mutableState.update { current ->
            if (current.phase != QuestionPhase.Answering) return@update current
            val drafts = current.drafts.toMutableList()
            drafts[current.step] = change(current.question, drafts[current.step])
            current.copy(drafts = drafts)
        }
    }
}

data class QuestionSheetState(
    val set: PendingQuestions,
    val step: Int,
    val drafts: List<Draft>,
    val phase: QuestionPhase,
) {
    val question: Question get() = set.questions[step]
    val draft: Draft get() = drafts[step]
    val isGrill: Boolean get() = set.source == QuestionsSource.Grill
    val isLastStep: Boolean get() = step == set.questions.lastIndex

    /** A grilling round may leave questions unanswered; AskUserQuestion needs every one. */
    val canGoOn: Boolean get() = isGrill || answerOf(question, draft) != null
}

/** What has been picked or typed for one question so far. */
data class Draft(
    /** In the order picked; sent in the options' order. */
    val picked: List<String>,
    val ownWords: String,
)

sealed interface QuestionPhase {
    data object Answering : QuestionPhase
    data object Sending : QuestionPhase

    /** The answers went in; the sheet closes. */
    data object Done : QuestionPhase

    /** [error] is the Mac's; null when the answer could not be sent. */
    data class Failed(val error: String?) : QuestionPhase

    /** "Answered on Mac" (or on another phone). */
    data class AnsweredElsewhere(val on: AnsweredOn) : QuestionPhase

    /** The CLI stopped waiting: the sheet goes away. */
    data object Withdrawn : QuestionPhase
}

/**
 * The answer [draft] gives [question]: own words on a single-select question, else the picked option; the picked
 * labels in the options' order joined with ", " (own words last) on a multi-select one. Null when nothing is.
 */
fun answerOf(question: Question, draft: Draft): String? {
    val ownWords = draft.ownWords.trim()
    if (!question.multiSelect) return ownWords.ifEmpty { draft.picked.firstOrNull() }
    val labels = question.options.map { it.label }.filter { it in draft.picked } + listOfNotNull(ownWords.ifEmpty { null })
    return labels.joinToString(", ").ifEmpty { null }
}

private const val RECOMMENDED_SUFFIX = "(Recommended)"

/** "WebSocket (Recommended)" → "WebSocket"; the label as sent stays as it is. */
fun displayLabelOf(label: String): String = label.removeSuffix(RECOMMENDED_SUFFIX).trimEnd()

fun isRecommended(label: String): Boolean = label.trimEnd().endsWith(RECOMMENDED_SUFFIX)
