package dev.jblaak.switchboard.ui.sessions

import dev.jblaak.switchboard.protocol.ErrandKind
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.PhoneSession
import dev.jblaak.switchboard.protocol.SessionState
import dev.jblaak.switchboard.protocol.TerminalOwner
import dev.jblaak.switchboard.protocol.WaitingReason

/**
 * The session list's three sections, each in the Mac's sidebar order, and the errands kept apart from them.
 *
 * An errand is a session Switchboard started by itself for a pull request. It is listed under the errands chip,
 * not in the sections, except that a stuck one also stays in [needsYou], after the user's own sessions.
 */
data class SessionList(
    val needsYou: List<SessionRow>,
    val working: List<SessionRow>,
    val ready: List<SessionRow>,
    /** Every errand, stuck or not, in the Mac's order. */
    val errands: List<SessionRow> = emptyList(),
) {
    val isEmpty: Boolean get() = needsYou.isEmpty() && working.isEmpty() && ready.isEmpty() && errands.isEmpty()

    /** How many errands need you; the chip turns red when any do. */
    val errandsNeedingYou: Int get() = errands.count { it.errand?.needsYou == true }
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
    /** What it does for which pull request, when Switchboard started it as an errand; null for the user's own. */
    val errand: Errand? = null,
)

/** An errand session's pull request and what it is doing there. */
data class Errand(
    val kind: ErrandKind,
    val number: Int,
    /** `owner/repo`. */
    val repository: String,
    val doing: String,
    /** Stuck: only the user can move it on. */
    val needsYou: Boolean,
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
    val (errands, own) = rows.partition { it.errand != null }
    return SessionList(
        needsYou = own.filter { it.status == SessionStatus.NeedsYou } + errands.filter { it.status == SessionStatus.NeedsYou },
        working = own.filter { it.status == SessionStatus.Working },
        ready = own.filter { it.status == SessionStatus.Ready },
        errands = errands,
    )
}

fun sessionRowOf(session: PhoneSession, pending: List<PendingQuestions>, deviceId: String): SessionRow {
    val errand = session.errand?.let { Errand(it.kind, it.number, it.repository, it.doing, it.needsYou) }
    // A stuck errand needs you even when its session sits at its prompt.
    val status = if (errand?.needsYou == true) SessionStatus.NeedsYou else statusOf(session.state)
    return SessionRow(
        id = session.id,
        name = session.name,
        project = session.project,
        remote = session.remote,
        status = status,
        waiting = waitingOf(session, pending),
        place = session.owner.placeFor(deviceId),
        changedAt = session.changedAt,
        errand = errand,
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
