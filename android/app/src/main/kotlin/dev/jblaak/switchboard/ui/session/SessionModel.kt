package dev.jblaak.switchboard.ui.session

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.PhoneSession
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.TerminalOwner
import dev.jblaak.switchboard.protocol.WaitingReason
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.sessions.SessionStatus
import dev.jblaak.switchboard.ui.sessions.TerminalPlace
import dev.jblaak.switchboard.ui.sessions.placeFor
import dev.jblaak.switchboard.ui.sessions.statusOf
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One open session: attaches at the terminal's size once the terminal has one, follows the session through
 * re-keys, knows which device is active, and sends the prompt box and the key bar to the PTY.
 *
 * The Mac streams a session to an attached phone only, and forgets the attachment when the connection drops, so
 * the model attaches again after every reconnect and on every new terminal view, each time from a reset screen.
 */
class SessionModel(
    private val link: PhoneLink,
    private val board: SessionBoard,
    private val deviceId: String,
    sessionId: String,
    /** The project Ask Patch just started this session in, for the "Started in …" note; else null. */
    startedIn: String?,
    private val scope: CoroutineScope,
) {

    private val facts = MutableStateFlow(Facts(sessionId, owner = null, ended = false, startedIn = startedIn))
    private val writes = Channel<TerminalWrite>(Channel.UNLIMITED)
    private var size: TerminalSize? = null
    private var attached = false

    /** For the terminal view, in order; a [TerminalWrite.Reset] comes before each replay. */
    val terminalWrites: Flow<TerminalWrite> = writes.receiveAsFlow()

    val state: StateFlow<SessionScreenState> = combine(facts, board.sessions, board.pending) { facts, sessions, pending ->
        screenStateOf(facts, sessions.firstOrNull { it.id == facts.sessionId }, pending)
    }.stateIn(scope, SharingStarted.Eagerly, screenStateOf(facts.value, null, emptyList()))

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.messages.collect { receive(it) }
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.terminalFrames.collect { frame ->
                if (frame.sessionId == facts.value.sessionId) writes.trySend(TerminalWrite.Output(frame.output))
            }
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var wasConnected = link.state.value is LinkState.Connected
            link.state.collect { linkState ->
                val connected = linkState is LinkState.Connected
                if (connected && !wasConnected) attach()
                if (!connected) attached = false
                wasConnected = connected
            }
        }
    }

    /** A terminal view loaded and fitted itself: a fresh screen, so the session replays into it. */
    fun terminalOpened(size: TerminalSize) {
        this.size = size
        board.terminalMeasured(size)
        attach()
    }

    fun terminalResized(size: TerminalSize) {
        if (size == this.size) return
        this.size = size
        board.terminalMeasured(size)
        if (attached) link.send(ClientMessage.Size(facts.value.sessionId, size.cols, size.rows))
    }

    fun useHere() {
        link.send(ClientMessage.UseHere(facts.value.sessionId))
    }

    /** Pastes [text] and presses Enter a moment later, once the CLI has taken the paste in. */
    fun sendPrompt(text: String) {
        if (text.isBlank()) return
        val sessionId = facts.value.sessionId
        link.send(ClientMessage.Input(sessionId, pasteOf(text)))
        scope.launch {
            delay(150.milliseconds)
            link.send(ClientMessage.Input(sessionId, TerminalKey.Enter.bytes))
        }
    }

    fun press(key: TerminalKey) {
        link.send(ClientMessage.Input(facts.value.sessionId, key.bytes))
    }

    fun startedNoteDismissed() {
        facts.update { it.copy(startedIn = null) }
    }

    /** The screen is going away: stop the stream. */
    fun close() {
        if (attached) link.send(ClientMessage.Detach(facts.value.sessionId))
        attached = false
    }

    private fun attach() {
        val size = size ?: return
        if (facts.value.ended) return
        writes.trySend(TerminalWrite.Reset)
        val outcome = link.send(ClientMessage.Attach(facts.value.sessionId, size.cols, size.rows))
        attached = outcome == SendOutcome.Sent
    }

    private fun receive(message: ServerMessage) {
        val sessionId = facts.value.sessionId
        when (message) {
            is ServerMessage.Attached -> if (message.sessionId == sessionId) facts.update { it.copy(owner = message.owner) }
            is ServerMessage.Owner -> if (message.sessionId == sessionId) facts.update { it.copy(owner = message.owner) }
            is ServerMessage.SessionRekeyed -> if (message.from == sessionId) facts.update { it.copy(sessionId = message.to) }
            is ServerMessage.Exited -> if (message.sessionId == sessionId) {
                attached = false
                facts.update { it.copy(ended = true) }
            }
            else -> Unit
        }
    }

    private fun screenStateOf(facts: Facts, session: PhoneSession?, pending: List<PendingQuestions>): SessionScreenState {
        val owner = facts.owner ?: session?.owner
        val questions = pending.filter { it.sessionId == facts.sessionId }
        return SessionScreenState(
            sessionId = facts.sessionId,
            name = session?.name,
            project = session?.project ?: facts.startedIn,
            status = session?.state?.let(::statusOf),
            access = when {
                facts.ended -> TerminalAccess.Ended
                owner == null -> TerminalAccess.Unknown
                else -> when (val place = owner.placeFor(deviceId)) {
                    TerminalPlace.ThisPhone -> TerminalAccess.Here
                    else -> TerminalAccess.Elsewhere(place)
                }
            },
            pendingQuestions = questions.firstOrNull(),
            waitingInTerminal = questions.isEmpty() && session?.waiting == WaitingReason.Terminal,
            startedIn = facts.startedIn,
        )
    }

    private data class Facts(
        val sessionId: String,
        /** From `attached` and `owner`; until one comes, the list's owner stands in. */
        val owner: TerminalOwner?,
        val ended: Boolean,
        val startedIn: String?,
    )
}

data class SessionScreenState(
    /** The session's current id, after any re-keys. */
    val sessionId: String,
    /** Null until the session is in the list (a session Ask Patch just started). */
    val name: String?,
    val project: String?,
    val status: SessionStatus?,
    val access: TerminalAccess,
    /** The first set of questions the session is blocked on, if any. */
    val pendingQuestions: PendingQuestions?,
    val waitingInTerminal: Boolean,
    val startedIn: String?,
)

/** Whether this phone shows the terminal, and if not, why. */
sealed interface TerminalAccess {
    /** Not attached yet. */
    data object Unknown : TerminalAccess

    /** This phone is the active device: the terminal, the key bar and the prompt box. */
    data object Here : TerminalAccess

    /** "Active on other device", with Use here. */
    data class Elsewhere(val place: TerminalPlace) : TerminalAccess

    data object Ended : TerminalAccess
}
