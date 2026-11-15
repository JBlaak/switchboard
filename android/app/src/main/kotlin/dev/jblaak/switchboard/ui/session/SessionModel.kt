package dev.jblaak.switchboard.ui.session

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.LandAction
import dev.jblaak.switchboard.protocol.MacFeatures
import dev.jblaak.switchboard.protocol.PhoneLand
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

    private val facts = MutableStateFlow(Facts(sessionId, owner = null, ended = false, archived = false, archivedElsewhere = false, startedIn = startedIn))
    private val writes = Channel<TerminalWrite>(Channel.UNLIMITED)
    private val landNotes = Channel<LandNote>(Channel.UNLIMITED)
    private var size: TerminalSize? = null
    private var attached = false

    /** The session as last listed, so an archived one keeps its name while the confetti plays. */
    private var lastListed: PhoneSession? = null

    /** For the terminal view, in order; a [TerminalWrite.Reset] comes before each replay. */
    val terminalWrites: Flow<TerminalWrite> = writes.receiveAsFlow()

    /** What came of a Land it or Unland from here, for a toast: the Mac's words. */
    val landResults: Flow<LandNote> = landNotes.receiveAsFlow()

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
                if (connected && !wasConnected) {
                    attach()
                    checkLand()
                }
                if (!connected) {
                    attached = false
                    // The answer is lost with the connection: the button comes back.
                    facts.update { it.copy(landing = null) }
                }
                wasConnected = connected
            }
        }
        checkLand()
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

    /**
     * Archives the session; false when it couldn't be sent, so nothing happened. The screen stays as it is until
     * it goes, rather than showing the session ending.
     */
    fun archive(): Boolean {
        val sent = board.archive(facts.value.sessionId) == SendOutcome.Sent
        if (sent) facts.update { it.copy(archived = true) }
        return sent
    }

    /**
     * Land it: hands the session's PR to the Mac's Merge manager, which merges it once it is approved and green;
     * false when it couldn't be sent. The button shows Landing… until the Mac answers.
     */
    fun land(): Boolean = sendLand(LandAction.Land)

    /** Takes the session's landed PR back out of its lane; false when it couldn't be sent. */
    fun unland(): Boolean = sendLand(LandAction.Unland)

    private fun sendLand(action: LandAction): Boolean {
        val sessionId = facts.value.sessionId
        val message = if (action == LandAction.Land) ClientMessage.Land(sessionId) else ClientMessage.Unland(sessionId)
        val sent = link.send(message) == SendOutcome.Sent
        if (sent) facts.update { it.copy(landing = action) }
        return sent
    }

    /** Asks the Mac to read the session's PRs from GitHub, so Land it knows a draft; only a Mac that offers it. */
    private fun checkLand() {
        if (!macLands()) return
        link.send(ClientMessage.LandCheck(facts.value.sessionId))
    }

    private fun macLands(): Boolean {
        val connected = link.state.value as? LinkState.Connected ?: return false
        return MacFeatures.LAND in connected.features
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

    /** Bytes the terminal page made itself, such as a scroll of a full-screen program. */
    fun terminalInput(data: String) {
        link.send(ClientMessage.Input(facts.value.sessionId, data))
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
            is ServerMessage.LandResult -> if (message.sessionId == sessionId) {
                facts.update { it.copy(landing = null) }
                val note = if (message.ok) message.text?.let { LandNote(it, failed = false) } else LandNote(message.error.orEmpty(), failed = true)
                if (note != null) landNotes.trySend(note)
            }
            is ServerMessage.Exited -> if (message.sessionId == sessionId) {
                attached = false
                facts.update { it.copy(ended = true) }
            }
            // Archived from here, the screen is going already, after its confetti.
            is ServerMessage.Archived -> if (message.sessionId == sessionId && !facts.value.archived) {
                attached = false
                facts.update { it.copy(archivedElsewhere = true) }
            }
            else -> Unit
        }
    }

    private fun screenStateOf(facts: Facts, listed: PhoneSession?, pending: List<PendingQuestions>): SessionScreenState {
        if (listed != null) lastListed = listed
        val session = listed ?: lastListed?.takeIf { facts.archived }
        val owner = facts.owner ?: session?.owner
        val questions = pending.filter { it.sessionId == facts.sessionId }
        return SessionScreenState(
            sessionId = facts.sessionId,
            name = session?.name,
            project = session?.project ?: facts.startedIn,
            status = session?.state?.let(::statusOf),
            access = when {
                facts.ended && !facts.archived -> TerminalAccess.Ended
                owner == null -> TerminalAccess.Unknown
                else -> when (val place = owner.placeFor(deviceId)) {
                    TerminalPlace.ThisPhone -> TerminalAccess.Here
                    else -> TerminalAccess.Elsewhere(place)
                }
            },
            pendingQuestions = questions.firstOrNull(),
            waitingInTerminal = questions.isEmpty() && session?.waiting == WaitingReason.Terminal,
            startedIn = facts.startedIn,
            archivedElsewhere = facts.archivedElsewhere,
            land = session?.land,
            landing = facts.landing,
        )
    }

    private data class Facts(
        val sessionId: String,
        /** From `attached` and `owner`; until one comes, the list's owner stands in. */
        val owner: TerminalOwner?,
        val ended: Boolean,
        /** Archived from here: the screen is about to go. */
        val archived: Boolean,
        /** Archived on the Mac or another phone. */
        val archivedElsewhere: Boolean,
        val startedIn: String?,
        /** A Land it or Unland sent from here that the Mac has not answered yet. */
        val landing: LandAction? = null,
    )
}

/** A Land it or Unland's answer, as the Mac's toast words it. */
data class LandNote(val text: String, val failed: Boolean)

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
    /** Archived on the Mac or another phone: the screen goes back to the list, as the Mac's view closes. */
    val archivedElsewhere: Boolean = false,
    /** Land it for the session's pull request, as the Mac's session header shows it; null when there is nothing to show. */
    val land: PhoneLand? = null,
    /** Landing… or Unlanding…, until the Mac answers. */
    val landing: LandAction? = null,
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
