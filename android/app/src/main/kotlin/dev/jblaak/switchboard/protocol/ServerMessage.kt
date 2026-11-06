package dev.jblaak.switchboard.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Mac to phone: one JSON text frame each, discriminated by `type`. Terminal output comes as [TerminalFrame]s. */
@Serializable
sealed interface ServerMessage {

    /**
     * The answer to `hello` on an enrolled connection; the full state follows. [addresses] are the hosts the Mac
     * listens on (LAN and VPN), all on the port this connection came in on; an older Mac leaves them out.
     * [features] are what it can do beyond the protocol version ([MacFeatures]); an older Mac leaves them out, and
     * closes the connection on a message it doesn't know, so the phone only sends a feature's messages to a Mac
     * that named it.
     */
    @Serializable
    @SerialName("welcome")
    data class Welcome(
        val protocol: Int,
        val macName: String,
        val deviceId: String,
        val addresses: List<String> = emptyList(),
        val features: List<String> = emptyList(),
    ) : ServerMessage

    /**
     * The Mac's addresses changed while connected (a VPN came up, a new Wi-Fi): what [Welcome.addresses] would hold
     * now, for the next time the phone has to find the Mac.
     */
    @Serializable
    @SerialName("addresses")
    data class Addresses(val addresses: List<String>) : ServerMessage

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

    /** Sent on welcome and whenever it changes (download progress in whole percents). */
    @Serializable
    @SerialName("voice-status")
    data class VoiceStatusChanged(val status: VoiceStatus) : ServerMessage

    /** Exactly one per [ClientMessage.VoiceStart] that wasn't cancelled. */
    @Serializable
    @SerialName("voice-result")
    data class VoiceTranscribed(val voiceId: String, val result: VoiceResult) : ServerMessage

    /** Sent on welcome and whenever the level or charging changes; null on a Mac without a battery. */
    @Serializable
    @SerialName("mac-battery")
    data class MacBatteryChanged(val battery: MacBattery?) : ServerMessage

    /** Every session's open grilling round with its draft answers, on welcome and after every change. */
    @Serializable
    @SerialName("grill")
    data class Grill(val views: List<GrillView>) : ServerMessage

    /** A `grill-*` call from this phone failed; [error] is in words for the card ("Answer a question first"). */
    @Serializable
    @SerialName("grill-error")
    data class GrillError(val sessionId: String, val roundId: String, val error: String) : ServerMessage

    /**
     * A subscribed session's chat, whole: on [ClientMessage.ChatSubscribe], and again when it starts over (a
     * re-key moved it to a new transcript). The latest messages, oldest first. [available] is false for a session
     * without a transcript on the Mac (a terminal, an SSH or VM session).
     */
    @Serializable
    @SerialName("chat")
    data class Chat(val sessionId: String, val available: Boolean, val messages: List<ChatMessage>) : ServerMessage

    /** Messages the transcript gained since the last [Chat] or [ChatAppend], to add at the end. */
    @Serializable
    @SerialName("chat-append")
    data class ChatAppend(val sessionId: String, val messages: List<ChatMessage>) : ServerMessage

    /** Sent before [CloseReason.NotPaired] when the device is revoked or the Mac's identity is reset. */
    @Serializable
    @SerialName("revoked")
    data object Revoked : ServerMessage
}
