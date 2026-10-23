package dev.jblaak.switchboard.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Question text to its answer: an option label, labels joined with ", ", or free text. */
typealias Answers = Map<String, String>

/** One choice on a question; mirrors QuestionOption in `src/domain/questions/question.ts`. */
@Serializable
data class QuestionOption(
    /** What the option says, and what goes back when it is picked; may end in "(Recommended)". */
    val label: String,
    /** May be empty. */
    val description: String,
    /** Optional mockup or code shown beside the option; absent on most options. */
    val preview: String? = null,
)

@Serializable
data class Question(
    /** The full question, and the key its answer is sent back under. */
    val question: String,
    /** A chip-sized label, 12 characters at most. May be empty. */
    val header: String,
    val options: List<QuestionOption>,
    val multiSelect: Boolean,
    /** More about the question as plain text; only a grilling round has one. */
    val detail: String? = null,
)

/** A set of questions a session is blocked on. */
@Serializable
data class PendingQuestions(
    val sessionId: String,
    /** The tool call's id; for a grilling round, one made up for it. */
    val toolUseId: String,
    val source: QuestionsSource,
    val questions: List<Question>,
    /** Epoch ms the questions were asked. */
    val askedAt: Long,
    /** Epoch ms the CLI gives up and asks in the terminal; null for a grilling round. */
    val deadline: Long?,
)

@Serializable
enum class QuestionsSource {
    /** An AskUserQuestion call held on the hook. */
    @SerialName("ask")
    Ask,

    /** A grilling round written out in a reply, answered by typing. */
    @SerialName("grill")
    Grill,
}

@Serializable
enum class QuestionsOutcome {
    @SerialName("answered")
    Answered,

    /** The hook request went away: timed out, session stopped, CLI interrupted. */
    @SerialName("withdrawn")
    Withdrawn,
}

/** Where an answer came from. */
@Serializable
enum class AnsweredOn {
    @SerialName("mac")
    Mac,

    @SerialName("phone")
    Phone,
}
