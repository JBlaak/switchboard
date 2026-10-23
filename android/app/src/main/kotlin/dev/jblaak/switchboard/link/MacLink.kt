package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.discovery.MacDiscovery
import dev.jblaak.switchboard.link.identity.DeviceIdentity
import dev.jblaak.switchboard.link.identity.DeviceKey
import dev.jblaak.switchboard.link.identity.KeyAccess
import dev.jblaak.switchboard.link.identity.KeyCreation
import dev.jblaak.switchboard.link.pairing.PairingStore
import dev.jblaak.switchboard.link.pairing.StoredPairing
import dev.jblaak.switchboard.link.transport.LinkConnection
import dev.jblaak.switchboard.link.transport.LinkTransport
import dev.jblaak.switchboard.link.transport.TransportEvent
import dev.jblaak.switchboard.link.transport.TransportFailure
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.CloseReason
import dev.jblaak.switchboard.protocol.PROTOCOL_VERSION
import dev.jblaak.switchboard.protocol.PairingInvite
import dev.jblaak.switchboard.protocol.ProtocolCodec
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.ServerMessageDecoding
import dev.jblaak.switchboard.protocol.TerminalFrame
import java.util.concurrent.atomic.AtomicReference
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The phone's one link to its Mac: pairs from a scanned invite, connects with the stored pairing, reconnects after
 * a drop while the key is unlocked, and turns every close code into a [LinkState]. Screens observe [state],
 * collect [messages] and [terminalFrames], and talk with [send].
 *
 * Call the commands from one thread (the main thread in the app).
 */
class MacLink(
    private val identity: DeviceIdentity,
    private val pairingStore: PairingStore,
    private val discovery: MacDiscovery,
    private val transport: LinkTransport,
    private val backoff: ReconnectBackoff,
    /** Sent with `pair` as the name the Mac shows: `Build.MODEL`. */
    private val deviceName: String,
    /** Sent with `hello`. */
    private val appVersion: String,
    private val scope: CoroutineScope,
) {

    private val codec = ProtocolCodec()

    private val mutableState = MutableStateFlow<LinkState>(LinkState.Idle)
    val state: StateFlow<LinkState> = mutableState.asStateFlow()

    private val mutableMessages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)

    /** Every message on an enrolled connection, `welcome` included. Not replayed: collect before [start]. */
    val messages: SharedFlow<ServerMessage> = mutableMessages.asSharedFlow()

    private val mutableTerminalFrames = MutableSharedFlow<TerminalFrame>(extraBufferCapacity = 256)
    val terminalFrames: SharedFlow<TerminalFrame> = mutableTerminalFrames.asSharedFlow()

    private val connected = AtomicReference<LinkConnection?>(null)
    private var job: Job? = null
    private var goalAfterUnlock: Goal = Goal.StayConnected

    /** Connects with the stored pairing, or settles on [LinkState.Unpaired] without one. */
    fun start() = pursue(Goal.StayConnected)

    /** After "Mac not found", "Phone access turned off" and the like. */
    fun retry() = pursue(Goal.StayConnected)

    /** Pairs with the Mac a scanned QR code points at, replacing any pairing there was. */
    fun pair(invite: PairingInvite) = pursue(Goal.Pair(invite))

    /** A BiometricPrompt succeeded: picks up what [LinkState.Locked] interrupted. */
    fun unlocked() {
        if (state.value == LinkState.Locked) pursue(goalAfterUnlock)
    }

    /** Forget this Mac: closes the link and deletes the key and the stored pairing. */
    fun forget() {
        halt()
        identity.delete()
        pairingStore.clear()
        mutableState.value = LinkState.Unpaired
    }

    fun stop() {
        halt()
        mutableState.value = LinkState.Idle
    }

    fun send(message: ClientMessage): SendOutcome {
        val connection = connected.get() ?: return SendOutcome.NotConnected
        return if (connection.send(codec.encode(message))) SendOutcome.Sent else SendOutcome.NotConnected
    }

    private fun pursue(goal: Goal) {
        val previous = job
        job = scope.launch {
            previous?.cancelAndJoin()
            when (goal) {
                Goal.StayConnected -> stayConnected()
                is Goal.Pair -> pairWith(goal.invite)
                is Goal.ResumePairing -> pairWithKey(goal.invite)
            }
        }
    }

    private fun halt() {
        job?.cancel()
        job = null
        connected.getAndSet(null)?.close(1000, "Stopped")
    }

    private suspend fun stayConnected() {
        var attempt = 0
        var refusals = 0
        var reconnecting = false
        while (true) {
            val pairing = pairingStore.loadOrNull() ?: return show(LinkState.Unpaired)
            val key = when (val access = identity.access()) {
                is KeyAccess.Usable -> access.key
                KeyAccess.Locked -> return lock(Goal.StayConnected)
                KeyAccess.Missing -> return unpairRevoked()
            }
            show(if (reconnecting) LinkState.Reconnecting else LinkState.Connecting)
            when (val dial = dialPaired(pairing, key, reconnecting)) {
                is Dial.Opened -> when (val end = pairedSession(dial, pairing)) {
                    is SessionEnd.Final -> return show(end.state)
                    SessionEnd.Revoked -> return unpairRevoked()
                    SessionEnd.Again -> {
                        if (backoff.delayBeforeOrNull(attempt++) == null) return show(LinkState.NotFound)
                        continue
                    }
                    is SessionEnd.Lost -> {
                        refusals = 0
                        if (end.wasConnected) {
                            attempt = 0
                            reconnecting = true
                            show(LinkState.Reconnecting)
                        }
                    }
                }
                is Dial.Failed -> {
                    refusals = if (TransportFailure.Refused in dial.failures) refusals + 1 else 0
                    if (refusals >= 2) return show(LinkState.NotPaired)
                }
            }
            if (identity.access() == KeyAccess.Locked) return lock(Goal.StayConnected)
            val wait = backoff.delayBeforeOrNull(attempt++) ?: return show(LinkState.NotFound)
            delay(wait)
        }
    }

    private suspend fun dialPaired(pairing: StoredPairing, key: DeviceKey, reconnecting: Boolean): Dial {
        val last = dial(listOf(pairing.lastAddress), key, pairing.macFingerprint)
        if (last is Dial.Opened) return last
        if (!reconnecting) show(LinkState.Searching)
        val found = discovery.discover() - pairing.lastAddress
        if (found.isEmpty()) return last
        if (!reconnecting) show(LinkState.Connecting)
        return dial(found, key, pairing.macFingerprint).orFailures(last)
    }

    private suspend fun pairedSession(dial: Dial.Opened, pairing: StoredPairing): SessionEnd {
        val connection = dial.connection
        return try {
            pairedConversation(dial, pairing)
        } finally {
            connected.compareAndSet(connection, null)
            connection.close(1000, "Done")
        }
    }

    private suspend fun pairedConversation(dial: Dial.Opened, pairing: StoredPairing): SessionEnd {
        val connection = dial.connection
        connection.send(codec.encode(ClientMessage.Hello(PROTOCOL_VERSION, appVersion)))
        var welcomed = false
        var revoked = false
        while (true) {
            val event = nextEvent(connection, welcomed) ?: return SessionEnd.Lost(welcomed)
            when (event) {
                TransportEvent.Opened -> Unit
                is TransportEvent.Binary -> TerminalFrame.decodeOrNull(event.bytes)?.let { mutableTerminalFrames.emit(it) }
                is TransportEvent.Closed -> return endOfPairedSession(event.code, welcomed, revoked)
                is TransportEvent.Failed -> return SessionEnd.Lost(welcomed)
                is TransportEvent.Text -> {
                    val message = decodedOrNull(event.text) ?: continue
                    when (message) {
                        is ServerMessage.Welcome -> {
                            welcomed = true
                            pairingStore.save(pairing.copy(macName = message.macName, lastAddress = dial.address))
                            connected.set(connection)
                            show(LinkState.Connected(message.deviceId, message.macName))
                        }
                        is ServerMessage.Pairing -> return SessionEnd.Final(LinkState.NotPaired)
                        ServerMessage.Revoked -> revoked = true
                        is ServerMessage.UpdateRequired -> return SessionEnd.Final(LinkState.UpdateRequired(message.macVersion))
                        else -> Unit
                    }
                    if (welcomed) mutableMessages.emit(message)
                }
            }
        }
    }

    /**
     * Only a `revoked` message, the Mac saying so explicitly, deletes the pairing; a bare 4003 shows "No longer
     * paired" and leaves Pair again or Forget this Mac to the user.
     */
    private fun endOfPairedSession(code: Int, welcomed: Boolean, revoked: Boolean): SessionEnd {
        return when (CloseReason.fromCodeOrNull(code)) {
            CloseReason.UpdateRequired -> SessionEnd.Final(LinkState.UpdateRequired(null))
            CloseReason.NotPaired -> if (revoked) SessionEnd.Revoked else SessionEnd.Final(LinkState.NotPaired)
            CloseReason.TurnedOff -> SessionEnd.Final(LinkState.TurnedOff)
            CloseReason.PairingOver -> SessionEnd.Again
            CloseReason.ProtocolError, null -> SessionEnd.Lost(welcomed)
        }
    }

    private suspend fun pairWith(invite: PairingInvite) {
        if (invite.protocol != PROTOCOL_VERSION) {
            return show(LinkState.PairFailed(PairFailure.ProtocolMismatch(invite.protocol)))
        }
        pairingStore.clear()
        if (identity.create() == KeyCreation.BiometricsUnavailable) return failPairing(PairFailure.BiometricsUnavailable)
        pairWithKey(invite)
    }

    private suspend fun pairWithKey(invite: PairingInvite) {
        val key = when (val access = identity.access()) {
            is KeyAccess.Usable -> access.key
            KeyAccess.Locked -> return lock(Goal.ResumePairing(invite))
            KeyAccess.Missing -> return failPairing(PairFailure.BiometricsUnavailable)
        }
        when (val dial = dialInvited(invite, key)) {
            is Dial.Failed -> failPairing(pairingFailureOf(dial.failures))
            is Dial.Opened -> when (val end = pairingSession(dial, invite)) {
                PairingEnd.Accepted -> stayConnected()
                is PairingEnd.Failed -> failPairing(end.failure)
                is PairingEnd.Final -> {
                    identity.delete()
                    show(end.state)
                }
            }
        }
    }

    private suspend fun dialInvited(invite: PairingInvite, key: DeviceKey): Dial {
        val invited = MacAddress(invite.host, invite.port)
        show(LinkState.Connecting)
        val direct = dial(listOf(invited), key, invite.fingerprint)
        if (direct is Dial.Opened) return direct
        show(LinkState.Searching)
        val found = discovery.discover() - invited
        if (found.isEmpty()) return direct
        show(LinkState.Connecting)
        return dial(found, key, invite.fingerprint).orFailures(direct)
    }

    private fun pairingFailureOf(failures: Set<TransportFailure>): PairFailure {
        return when {
            TransportFailure.Refused in failures -> PairFailure.NotPairing
            TransportFailure.WrongMac in failures -> PairFailure.WrongMac
            else -> PairFailure.NotFound
        }
    }

    private suspend fun pairingSession(dial: Dial.Opened, invite: PairingInvite): PairingEnd {
        return try {
            pairingConversation(dial, invite)
        } finally {
            dial.connection.close(1000, "Done")
        }
    }

    private suspend fun pairingConversation(dial: Dial.Opened, invite: PairingInvite): PairingEnd {
        val connection = dial.connection
        connection.send(codec.encode(ClientMessage.Hello(PROTOCOL_VERSION, appVersion)))
        var macName = ""
        var accepted = false
        while (true) {
            val event = nextEvent(connection, macName.isNotEmpty()) ?: return PairingEnd.Failed(PairFailure.Interrupted)
            when (event) {
                TransportEvent.Opened, is TransportEvent.Binary -> Unit
                is TransportEvent.Closed -> return if (accepted) PairingEnd.Accepted else endOfPairingSession(event.code)
                is TransportEvent.Failed -> return if (accepted) PairingEnd.Accepted else PairingEnd.Failed(PairFailure.Interrupted)
                is TransportEvent.Text -> when (val message = decodedOrNull(event.text)) {
                    is ServerMessage.Pairing -> {
                        macName = message.macName
                        show(LinkState.Pairing(macName))
                        connection.send(codec.encode(ClientMessage.Pair(invite.code, deviceName)))
                    }
                    ServerMessage.PairPending -> show(LinkState.PairPending(macName))
                    is ServerMessage.PairAccepted -> {
                        accepted = true
                        pairingStore.save(StoredPairing(invite.fingerprint, message.deviceId, macName, dial.address))
                    }
                    is ServerMessage.PairRejected -> return PairingEnd.Failed(PairFailure.Rejected(message.reason))
                    is ServerMessage.Welcome -> {
                        pairingStore.save(StoredPairing(invite.fingerprint, message.deviceId, message.macName, dial.address))
                        return PairingEnd.Accepted
                    }
                    is ServerMessage.UpdateRequired -> return PairingEnd.Final(LinkState.UpdateRequired(message.macVersion))
                    else -> Unit
                }
            }
        }
    }

    private fun endOfPairingSession(code: Int): PairingEnd {
        return when (CloseReason.fromCodeOrNull(code)) {
            CloseReason.UpdateRequired -> PairingEnd.Final(LinkState.UpdateRequired(null))
            CloseReason.TurnedOff -> PairingEnd.Final(LinkState.TurnedOff)
            CloseReason.PairingOver -> PairingEnd.Failed(PairFailure.NotPairing)
            CloseReason.NotPaired, CloseReason.ProtocolError, null -> PairingEnd.Failed(PairFailure.Interrupted)
        }
    }

    private suspend fun dial(candidates: List<MacAddress>, key: DeviceKey, fingerprint: String): Dial {
        val failures = mutableSetOf<TransportFailure>()
        for (address in candidates) {
            val connection = transport.open(address, key, fingerprint)
            var opened = false
            try {
                when (val event = connection.events.receiveCatching().getOrNull()) {
                    TransportEvent.Opened -> opened = true
                    is TransportEvent.Failed -> failures += event.failure
                    else -> failures += TransportFailure.Unreachable
                }
            } finally {
                if (!opened) connection.close(1000, "Not used")
            }
            if (opened) return Dial.Opened(connection, address)
        }
        return Dial.Failed(failures)
    }

    /** The next event; before the Mac's first answer, null when it takes longer than ten seconds. */
    private suspend fun nextEvent(connection: LinkConnection, answered: Boolean): TransportEvent? {
        if (answered) return connection.events.receiveCatching().getOrNull()
        return withTimeoutOrNull(10.seconds) { connection.events.receiveCatching().getOrNull() }
    }

    private fun decodedOrNull(text: String): ServerMessage? {
        return when (val decoding = codec.decode(text)) {
            is ServerMessageDecoding.Decoded -> decoding.message
            is ServerMessageDecoding.Unreadable -> null
        }
    }

    private suspend fun failPairing(failure: PairFailure) {
        identity.delete()
        pairingStore.clear()
        show(LinkState.PairFailed(failure))
    }

    private suspend fun unpairRevoked() {
        identity.delete()
        pairingStore.clear()
        show(LinkState.NotPaired)
    }

    private suspend fun lock(goal: Goal) {
        goalAfterUnlock = goal
        show(LinkState.Locked)
    }

    private suspend fun show(state: LinkState) {
        currentCoroutineContext().ensureActive()
        mutableState.value = state
    }

    private sealed interface Goal {
        data object StayConnected : Goal
        data class Pair(val invite: PairingInvite) : Goal
        data class ResumePairing(val invite: PairingInvite) : Goal
    }

    private sealed interface Dial {
        class Opened(val connection: LinkConnection, val address: MacAddress) : Dial
        class Failed(val failures: Set<TransportFailure>) : Dial

        fun orFailures(earlier: Dial): Dial {
            if (this !is Failed || earlier !is Failed) return this
            return Failed(failures + earlier.failures)
        }
    }

    private sealed interface SessionEnd {
        data class Final(val state: LinkState) : SessionEnd
        data object Revoked : SessionEnd
        data object Again : SessionEnd
        data class Lost(val wasConnected: Boolean) : SessionEnd
    }

    private sealed interface PairingEnd {
        data object Accepted : PairingEnd
        data class Failed(val failure: PairFailure) : PairingEnd
        data class Final(val state: LinkState) : PairingEnd
    }
}

sealed interface SendOutcome {
    data object Sent : SendOutcome

    /** No enrolled connection is open; the message was dropped. */
    data object NotConnected : SendOutcome
}
