package dev.jblaak.switchboard.ui.sessions

import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.PhoneSession
import dev.jblaak.switchboard.protocol.SessionState
import dev.jblaak.switchboard.protocol.TerminalOwner
import dev.jblaak.switchboard.protocol.WaitingReason

/** The session list's three sections, each in the Mac's sidebar order. */
data class SessionList(
    val needsYou: List<SessionRow>,
    val working: List<SessionRow>,
    val ready: List<SessionRow>,
) {
    val isEmpty: Boolean get() = needsYou.isEmpty() && working.isEmpty() && ready.isEmpty()
}

data class SessionRow(
    val id: String,
    val name: String,
    val project: String,
    /** "user@host" for an SSH session. */
    val remote: String?,
    val status: SessionStatus,
    val waiting: Waiting?,
    val place: TerminalPlace,
    val changedAt: Long,
)

enum class SessionStatus { NeedsYou, Working, Ready }

/** Why a session needs you. */
sealed interface Waiting {
    /** Questions the phone can answer; [count] of them across its pending sets. */
    data class Questions(val count: Int) : Waiting

    data object Terminal : Waiting
}

/** Which device a session's terminal is active on, seen from this phone. */
sealed interface TerminalPlace {
    data object Mac : TerminalPlace
    data object ThisPhone : TerminalPlace
    data class OtherPhone(val name: String) : TerminalPlace
}

fun sessionListOf(sessions: List<PhoneSession>, pending: List<PendingQuestions>, deviceId: String): SessionList {
    val rows = sessions.map { sessionRowOf(it, pending, deviceId) }
    return SessionList(
        needsYou = rows.filter { it.status == SessionStatus.NeedsYou },
        working = rows.filter { it.status == SessionStatus.Working },
        ready = rows.filter { it.status == SessionStatus.Ready },
    )
}

fun sessionRowOf(session: PhoneSession, pending: List<PendingQuestions>, deviceId: String): SessionRow {
    return SessionRow(
        id = session.id,
        name = session.name,
        project = session.project,
        remote = session.remote,
        status = statusOf(session.state),
        waiting = waitingOf(session, pending),
        place = session.owner.placeFor(deviceId),
        changedAt = session.changedAt,
    )
}

fun statusOf(state: SessionState): SessionStatus {
    return when (state) {
        SessionState.NeedsYou -> SessionStatus.NeedsYou
        SessionState.Busy -> SessionStatus.Working
        SessionState.Idle -> SessionStatus.Ready
    }
}

fun TerminalOwner.placeFor(deviceId: String): TerminalPlace {
    return when (this) {
        TerminalOwner.Mac -> TerminalPlace.Mac
        is TerminalOwner.Device -> if (this.deviceId == deviceId) TerminalPlace.ThisPhone else TerminalPlace.OtherPhone(name)
    }
}

private fun waitingOf(session: PhoneSession, pending: List<PendingQuestions>): Waiting? {
    val questions = pending.filter { it.sessionId == session.id }.sumOf { it.questions.size }
    if (questions > 0) return Waiting.Questions(questions)
    return when (session.waiting) {
        WaitingReason.Questions -> Waiting.Questions(1)
        WaitingReason.Terminal -> Waiting.Terminal
        null -> null
    }
}

/** "2m", "3h", "2d" since [changedAt]; null under a minute. */
fun elapsedLabelOrNull(changedAt: Long, now: Long): String? {
    val minutes = (now - changedAt).coerceAtLeast(0) / 60_000
    return when {
        minutes < 1 -> null
        minutes < 60 -> "${minutes}m"
        minutes < 24 * 60 -> "${minutes / 60}h"
        else -> "${minutes / (24 * 60)}d"
    }
}
