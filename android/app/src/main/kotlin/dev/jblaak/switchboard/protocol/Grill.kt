package dev.jblaak.switchboard.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/*
 * A grilling round as the Mac shows it on its grilling card: mirrors the view shapes in `src/domain/grill/model.ts`.
 * A session running a grilling skill ends a turn with numbered questions, each with a reason and Claude's
 * recommendation; the draft answers live on the Mac, and the phone edits the same drafts through the `grill-*`
 * messages and shows whatever the next [ServerMessage.Grill] says.
 */

/** One lettered choice a question's reason offers inline: `(a) Forever; (b) 30 days`. */
@Serializable
data class Choice(
    /** `a`, `b`, … in order. */
    val letter: String,
    val text: String,
)

/** A reason split around its inline choices. */
@Serializable
data class Choices(
    /** The reason's text before the first choice. */
    val lead: String,
    val list: List<Choice>,
    /** The reason's text after the last choice's sentence. */
    val after: String,
)

/** A draft answer to one question. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface GrillAnswer {

    /** "Yes, go with that": Claude's recommendation. */
    @Serializable
    @SerialName("accepted")
    data object Accepted : GrillAnswer

    /** The recommendation, with a note. */
    @Serializable
    @SerialName("noted")
    data class Noted(val note: String) : GrillAnswer

    /** An answer of the user's own, or a choice other than the recommended one: `(b) 30 days`. */
    @Serializable
    @SerialName("overridden")
    data class Overridden(val text: String) : GrillAnswer
}

/** How a revision touched a question. */
@Serializable
enum class GrillMark {
    @SerialName("changed")
    Changed,

    @SerialName("new")
    New,
}

/** idle: nothing queued. queued: sends once research is done. unsent: a revision cancelled a queued send. */
@Serializable
enum class GrillSendState {
    @SerialName("idle")
    Idle,

    @SerialName("queued")
    Queued,

    @SerialName("unsent")
    Unsent,
}

/** One question of the open round with its draft answer. */
@Serializable
data class GrillQuestionView(
    /** The number as the round printed it; what the answer goes back under (`Q3: …`). */
    val number: Int,
    /** Inline Markdown. */
    val title: String,
    /** Markdown: why Claude asks. */
    val reason: String,
    /** Markdown: what Claude would do. */
    val recommendation: String,
    /** Present only when the reason offers two or more inline lettered choices. */
    val choices: Choices? = null,
    /** The letter the recommendation opens with, when it names one of the choices. */
    val recommendedChoice: String? = null,
    val answer: GrillAnswer?,
    /** The answer given before a revision changed the question: shown, never sent. */
    val setAside: GrillAnswer?,
    val mark: GrillMark?,
    /** The user asked about this question (Ask about this, or Wait, what?) and the session has seen it. */
    val asked: Boolean,
    /** The text of the turn that answered the ask, once it has ended. */
    val explanation: String?,
)

/** A session's open round, as the Mac's grilling card has it. */
@Serializable
data class GrillView(
    val sessionId: String,
    /** Stable across revisions. */
    val roundId: String,
    /** Bumped by each revision; answers name the revision they were given against. */
    val revision: Int,
    /** Markdown the round opens with before its first question; empty when none. */
    val preamble: String,
    val questions: List<GrillQuestionView>,
    /** Questions revisions dropped. */
    val dropped: Int,
    /** Background agents of the session still running. */
    val agentsRunning: Int,
    val send: GrillSendState,
    /** The place of the question an ask is under way for. */
    val asking: Int?,
)
