package dev.jblaak.switchboard.ui.connected

import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.PhoneSession
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.session.TerminalSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The Mac's running sessions and pending questions, as the phone last heard them. Both arrive right after
 * `welcome` and then on every change, and [PhoneLink.messages] does not replay, so create the board before the
 * link starts and keep it as long as the link.
 */
class SessionBoard(private val link: PhoneLink, scope: CoroutineScope) {

    /** The list as the Mac last sent it, archiving ones included. */
    private var received: List<PhoneSession> = emptyList()

    /** Archived here and not yet gone from the Mac's list: hidden meanwhile, back if the Mac couldn't stop them. */
    private var archiving: Set<String> = emptySet()

    private val mutableSessions = MutableStateFlow<List<PhoneSession>>(emptyList())

    /** In the Mac's sidebar order. */
    val sessions: StateFlow<List<PhoneSession>> = mutableSessions.asStateFlow()

    private val mutableArchiveFailures = MutableSharedFlow<String>(
        extraBufferCapacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Why an archive failed, as the Mac said it; the session is listed again. */
    val archiveFailures: SharedFlow<String> = mutableArchiveFailures.asSharedFlow()

    private val mutablePending = MutableStateFlow<List<PendingQuestions>>(emptyList())
    val pending: StateFlow<List<PendingQuestions>> = mutablePending.asStateFlow()

    private val mutableTerminalSize = MutableStateFlow<TerminalSize?>(null)

    /** The size this phone's terminal last fitted to, for a session Ask Patch starts; null before the first one. */
    val terminalSize: StateFlow<TerminalSize?> = mutableTerminalSize.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.messages.collect { receive(it) }
        }
    }

    fun terminalMeasured(size: TerminalSize) {
        mutableTerminalSize.value = size
    }

    /** Asks the Mac to archive [sessionId] and takes it off the list at once, as the Mac's row slides out. */
    fun archive(sessionId: String): SendOutcome {
        val outcome = link.send(ClientMessage.Archive(sessionId))
        if (outcome == SendOutcome.Sent) {
            archiving = archiving + sessionId
            publish()
        }
        return outcome
    }

    private fun receive(message: ServerMessage) {
        when (message) {
            is ServerMessage.Sessions -> {
                received = message.sessions
                // Gone from the Mac's list: nothing left to hide.
                archiving = archiving.filterTo(mutableSetOf()) { id -> received.any { it.id == id } }
                publish()
            }
            is ServerMessage.Questions -> mutablePending.value = message.pending
            is ServerMessage.SessionRekeyed -> rekey(message.from, message.to)
            is ServerMessage.Owner -> {
                received = received.map { session ->
                    if (session.id == message.sessionId) session.copy(owner = message.owner) else session
                }
                publish()
            }
            is ServerMessage.Exited -> drop(message.sessionId)
            is ServerMessage.Archived -> drop(message.sessionId)
            is ServerMessage.ArchiveResult -> if (!message.ok) {
                archiving = archiving - message.sessionId
                publish()
                mutableArchiveFailures.tryEmit(message.error.orEmpty())
            }
            else -> Unit
        }
    }

    /** Ended or archived: off the list, with its questions, before the Mac's next list says so. */
    private fun drop(sessionId: String) {
        received = received.filterNot { it.id == sessionId }
        archiving = archiving - sessionId
        publish()
        mutablePending.value = mutablePending.value.filterNot { it.sessionId == sessionId }
    }

    private fun publish() {
        mutableSessions.value = received.filterNot { it.id in archiving }
    }

    private fun rekey(from: String, to: String) {
        received = received.map { session ->
            if (session.id == from) session.copy(id = to) else session
        }
        if (from in archiving) archiving = archiving - from + to
        publish()
        mutablePending.value = mutablePending.value.map { set ->
            if (set.sessionId == from) set.copy(sessionId = to) else set
        }
    }
}
