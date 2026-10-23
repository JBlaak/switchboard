package dev.jblaak.switchboard.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * Who a session's terminal is sized for: one active device per session. Compare [Device.deviceId] with this
 * phone's own to tell "here" from "another phone".
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface TerminalOwner {

    @Serializable
    @SerialName("mac")
    data object Mac : TerminalOwner

    @Serializable
    @SerialName("device")
    data class Device(val deviceId: String, val name: String) : TerminalOwner
}

/** A running session as the phone lists it, in the sidebar's order. */
@Serializable
data class PhoneSession(
    /** The session's current id; follows re-keys (see [ServerMessage.SessionRekeyed]). */
    val id: String,
    val name: String,
    /** The project's folder name, e.g. "switchboard". */
    val project: String,
    val projectPath: String,
    /** "user@host" for an SSH session, else null. */
    val remote: String?,
    val state: SessionState,
    /** Why it needs you, when it does. */
    val waiting: WaitingReason?,
    val owner: TerminalOwner,
    /** Epoch ms of the last state change. */
    val changedAt: Long,
)

@Serializable
enum class SessionState {
    /** A turn is running. */
    @SerialName("busy")
    Busy,

    /** Waiting for a prompt. */
    @SerialName("idle")
    Idle,

    /** Blocked on the user. */
    @SerialName("needs-you")
    NeedsYou,
}

@Serializable
enum class WaitingReason {
    /** Questions the app can answer. */
    @SerialName("questions")
    Questions,

    /** Something in the terminal. */
    @SerialName("terminal")
    Terminal,
}

/** A local project Ask Patch may start a session in. */
@Serializable
data class PhoneProject(
    val path: String,
    /** The folder name it is listed under. */
    val folder: String,
    /** Sessions running in it right now. */
    val running: Int,
)

/** What came of an Ask Patch request. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface PhoneAskResult {

    @Serializable
    @SerialName("confident")
    data class Confident(val sessionId: String, val project: String) : PhoneAskResult

    /** Up to three [candidates], best first. */
    @Serializable
    @SerialName("unsure")
    data class Unsure(val candidates: List<AskCandidate>, val prompt: String) : PhoneAskResult

    /** Patch's one line; the phone shows the project list next. */
    @Serializable
    @SerialName("noMatch")
    data class NoMatch(val reason: String) : PhoneAskResult

    @Serializable
    @SerialName("failed")
    data class Failed(val reason: String) : PhoneAskResult

    @Serializable
    @SerialName("cancelled")
    data object Cancelled : PhoneAskResult
}

/** A project Patch thinks the request may be about, with its most recent session title. */
@Serializable
data class AskCandidate(
    val path: String,
    val folder: String,
    val recentTitle: String?,
)

/** Why a pairing attempt was turned away. */
@Serializable
enum class PairRejection {
    @SerialName("expired")
    Expired,

    @SerialName("wrong-code")
    WrongCode,

    @SerialName("locked-out")
    LockedOut,

    @SerialName("declined")
    Declined,

    @SerialName("not-pairing")
    NotPairing,
}
