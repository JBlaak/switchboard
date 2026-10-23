package dev.jblaak.switchboard.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Mac to phone: one JSON text frame each, discriminated by `type`. Terminal output comes as [TerminalFrame]s. */
@Serializable
sealed interface ServerMessage {

    /** The answer to `hello` on an enrolled connection; the full state follows. */
    @Serializable
    @SerialName("welcome")
    data class Welcome(val protocol: Int, val macName: String, val deviceId: String) : ServerMessage

    /** The answer to `hello` on a pairing connection. */
    @Serializable
    @SerialName("pairing")
    data class Pairing(val protocol: Int, val macName: String) : ServerMessage

    /** The code was right; the Mac is showing the confirm dialog. */
    @Serializable
    @SerialName("pair-pending")
    data object PairPending : ServerMessage

    /** Confirmed on the Mac; reconnect as enrolled. Followed by [CloseReason.PairingOver]. */
    @Serializable
    @SerialName("pair-accepted")
    data class PairAccepted(val deviceId: String) : ServerMessage

    @Serializable
    @SerialName("pair-rejected")
    data class PairRejected(val reason: PairRejection) : ServerMessage

    /** Sent instead of `welcome` before [CloseReason.UpdateRequired]. */
    @Serializable
    @SerialName("update-required")
    data class UpdateRequired(val protocol: Int, val macVersion: String) : ServerMessage

    /** The whole running list, on welcome and on every change. */
    @Serializable
    @SerialName("sessions")
    data class Sessions(val sessions: List<PhoneSession>) : ServerMessage

    /** A fork or plan-accept gave a session a new id; move the row and any open view. */
    @Serializable
    @SerialName("session-rekeyed")
    data class SessionRekeyed(val from: String, val to: String) : ServerMessage

    /** Sent before the replay frames of an attach. */
    @Serializable
    @SerialName("attached")
    data class Attached(val sessionId: String, val owner: TerminalOwner) : ServerMessage

    @Serializable
    @SerialName("owner")
    data class Owner(val sessionId: String, val owner: TerminalOwner) : ServerMessage

    /** The session's process ended. */
    @Serializable
    @SerialName("exited")
    data class Exited(val sessionId: String, val exitCode: Int) : ServerMessage

    /** Every pending question set, on welcome and on every change. */
    @Serializable
    @SerialName("questions")
    data class Questions(val pending: List<PendingQuestions>) : ServerMessage

    @Serializable
    @SerialName("questions-settled")
    data class QuestionsSettled(
        val sessionId: String,
        val toolUseId: String,
        val outcome: QuestionsOutcome,
        val answeredOn: AnsweredOn?,
    ) : ServerMessage

    /** [error] is only there when [ok] is false. */
    @Serializable
    @SerialName("answer-result")
    data class AnswerResult(
        val sessionId: String,
        val toolUseId: String,
        val ok: Boolean,
        val error: String? = null,
    ) : ServerMessage

    /** [error] is only there when [ok] is false. */
    @Serializable
    @SerialName("archive-result")
    data class ArchiveResult(
        val sessionId: String,
        val ok: Boolean,
        val error: String? = null,
    ) : ServerMessage

    /** Archived on the Mac or from another phone: an open screen of it closes. */
    @Serializable
    @SerialName("archived")
    data class Archived(val sessionId: String) : ServerMessage

    @Serializable
    @SerialName("ask-result")
    data class AskResult(val requestId: String, val result: PhoneAskResult) : ServerMessage

    @Serializable
    @SerialName("ask-started")
    data class AskStarted(val requestId: String, val sessionId: String) : ServerMessage

    @Serializable
    @SerialName("ask-error")
    data class AskError(val requestId: String, val error: String) : ServerMessage

    @Serializable
    @SerialName("projects")
    data class Projects(val projects: List<PhoneProject>) : ServerMessage

    /** Sent before [CloseReason.NotPaired] when the device is revoked or the Mac's identity is reset. */
    @Serializable
    @SerialName("revoked")
    data object Revoked : ServerMessage
}
