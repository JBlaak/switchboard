package dev.jblaak.switchboard.ui.connected

import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.PhoneSession
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.session.TerminalSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The Mac's running sessions and pending questions, as the phone last heard them. Both arrive right after
 * `welcome` and then on every change, and [PhoneLink.messages] does not replay, so create the board before the
 * link starts and keep it as long as the link.
 */
class SessionBoard(link: PhoneLink, scope: CoroutineScope) {

    private val mutableSessions = MutableStateFlow<List<PhoneSession>>(emptyList())

    /** In the Mac's sidebar order. */
    val sessions: StateFlow<List<PhoneSession>> = mutableSessions.asStateFlow()

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

    private fun receive(message: ServerMessage) {
        when (message) {
            is ServerMessage.Sessions -> mutableSessions.value = message.sessions
            is ServerMessage.Questions -> mutablePending.value = message.pending
            is ServerMessage.SessionRekeyed -> rekey(message.from, message.to)
            is ServerMessage.Owner -> mutableSessions.value = mutableSessions.value.map { session ->
                if (session.id == message.sessionId) session.copy(owner = message.owner) else session
            }
            is ServerMessage.Exited -> {
                mutableSessions.value = mutableSessions.value.filterNot { it.id == message.sessionId }
                mutablePending.value = mutablePending.value.filterNot { it.sessionId == message.sessionId }
            }
            else -> Unit
        }
    }

    private fun rekey(from: String, to: String) {
        mutableSessions.value = mutableSessions.value.map { session ->
            if (session.id == from) session.copy(id = to) else session
        }
        mutablePending.value = mutablePending.value.map { set ->
            if (set.sessionId == from) set.copy(sessionId = to) else set
        }
    }
}
