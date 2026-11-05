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
 * [nudge] and [networkChanged] cut a reconnect's wait short when the app comes to the front or the phone's network
 * changes. What it does goes to [logger].
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
    private val logger: LinkLogger = LinkLogger.Silent,
) {

    private val codec = ProtocolCodec()

    private val mutableState = MutableStateFlow<LinkState>(LinkState.Idle)
    val state: StateFlow<LinkState> = mutableState.asStateFlow()

    private val mutableLastConnected = MutableStateFlow<LinkState.Connected?>(null)

    /**
     * The last [LinkState.Connected] this process saw, kept through [LinkState.Reconnecting], the lock and the like,
     * so the connected screens have the device id and the Mac's name while the link is down. Null again once the
     * pairing is gone.
     */
    val lastConnected: StateFlow<LinkState.Connected?> = mutableLastConnected.asStateFlow()

    /** [lastConnected], or else the stored pairing's device id and Mac name; null when this phone isn't paired. */
    fun lastConnectedOrStored(): LinkState.Connected? {
        return lastConnected.value
            ?: pairingStore.loadOrNull()?.let { LinkState.Connected(deviceId = it.deviceId, macName = it.macName) }
    }

    private val mutableMessages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)

    /** Every message on an enrolled connection, `welcome` included. Not replayed: collect before [start]. */
    val messages: SharedFlow<ServerMessage> = mutableMessages.asSharedFlow()

    private val mutableTerminalFrames = MutableSharedFlow<TerminalFrame>(extraBufferCapacity = 256)
    val terminalFrames: SharedFlow<TerminalFrame> = mutableTerminalFrames.asSharedFlow()

    private val connected = AtomicReference<LinkConnection?>(null)
    private var job: Job? = null
    private var goalAfterUnlock: Goal = Goal.StayConnected()

    /** Set while [stayConnected] waits out a backoff delay: what [nudge] may cut short. */
    @Volatile
    private var pendingRedial: PendingRedial? = null

    /** Connects with the stored pairing, or settles on [LinkState.Unpaired] without one. */
    fun start() = pursue(Goal.StayConnected())

    /** After "Mac not found", "Phone access turned off" and the like. */
    fun retry() = pursue(Goal.StayConnected())

    /**
     * Something suggests the Mac may be reachable now ([reason]: the app came to the front, the network changed):
     * from [LinkState.NotFound], or while waiting out a backoff delay before the next attempt, dials at once with a
     * fresh set of attempts. Does nothing otherwise: not over a dial already under way, a connection, the lock,
     * pairing or a state the user has to act on.
     */
    fun nudge(reason: String) {
        val waiting = pendingRedial
        when {
            state.value == LinkState.NotFound -> {
                logger.info("Nudged ($reason): not found, dialling again")
                pursue(Goal.StayConnected())
            }
            waiting != null -> {
                logger.info("Nudged ($reason): skipping the wait, dialling now")
                pursue(Goal.StayConnected(reconnecting = waiting.reconnecting))
            }
            else -> logger.info("Nudged ($reason): nothing to do while ${state.value}")
        }
    }

    /**
     * The phone's network changed and it now has [phoneAddresses]. A connection whose own address is not among them
     * went out over a network that is gone and won't hear another byte, so it is dropped and dialled again at once
     * instead of waiting for the ping to time out; a connection that still has its address is left alone. When not
     * connected, this is a [nudge].
     */
    fun networkChanged(phoneAddresses: Set<String>) {
        if (state.value !is LinkState.Connected) return nudge("network changed")
        val localAddress = connected.get()?.localAddress
        if (localAddress == null || localAddress in phoneAddresses) {
            logger.info("Network changed; the connection from ${localAddress ?: "an unknown address"} stays")
            return
        }
        logger.info("Network changed; $localAddress is gone, dropping the connection and dialling again")
        pursue(Goal.StayConnected(reconnecting = true))
    }

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
        mutableLastConnected.value = null
        setState(LinkState.Unpaired)
    }

    fun stop() {
        halt()
        setState(LinkState.Idle)
    }

    fun send(message: ClientMessage): SendOutcome {
        val connection = connected.get() ?: return SendOutcome.NotConnected
        return if (connection.send(codec.encode(message))) SendOutcome.Sent else SendOutcome.NotConnected
    }

    private fun pursue(goal: Goal) {
        // Cancelled here, not in the new job, so the replaced job can't start another wait in between: a nudge from
        // here on must not cut into the new goal.
        val previous = job
        previous?.cancel()
        pendingRedial = null
        job = scope.launch {
            previous?.join()
            when (goal) {
                is Goal.StayConnected -> stayConnected(goal.reconnecting)
                is Goal.Pair -> pairWith(goal.invite)
                is Goal.ResumePairing -> pairWithKey(goal.invite)
            }
        }
    }

    private fun halt() {
        pendingRedial = null
        job?.cancel()
        job = null
        connected.getAndSet(null)?.close(1000, "Stopped")
    }

    private suspend fun stayConnected(wasConnected: Boolean) {
        var attempt = 0
        var refusals = 0
        var reconnecting = wasConnected
        while (true) {
            val pairing = pairingStore.loadOrNull() ?: return show(LinkState.Unpaired)
            val key = when (val access = identity.access()) {
                is KeyAccess.Usable -> access.key
                KeyAccess.Locked -> return lock(Goal.StayConnected(reconnecting))
                KeyAccess.Missing -> return unpairRevoked()
            }
            show(if (reconnecting) LinkState.Reconnecting else LinkState.Connecting)
            when (val dial = dialPaired(pairing, key, reconnecting)) {
                is Dial.Opened -> when (val end = pairedSession(dial, pairing)) {
                    is SessionEnd.Final -> return show(end.state)
                    SessionEnd.Revoked -> return unpairRevoked()
                    SessionEnd.Again -> {
                        if (backoff.delayBeforeOrNull(attempt++) == null) return giveUp()
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
            if (identity.access() == KeyAccess.Locked) return lock(Goal.StayConnected(reconnecting))
            val wait = backoff.delayBeforeOrNull(attempt++) ?: return giveUp()
            logger.info("Dialling again in $wait (${if (reconnecting) "reconnecting" else "connecting"}, wait $attempt)")
            pendingRedial = PendingRedial(reconnecting)
            try {
                delay(wait)
            } finally {
                pendingRedial = null
            }
        }
    }

    private suspend fun giveUp() {
        logger.warn("Out of attempts: the Mac is not found")
        show(LinkState.NotFound)
    }

    private suspend fun dialPaired(pairing: StoredPairing, key: DeviceKey, reconnecting: Boolean): Dial {
        val last = dial(listOf(pairing.lastAddress), key, pairing.macFingerprint, source = "last address")
        if (last is Dial.Opened) return last
        val known = pairing.knownHosts.map { MacAddress(it, pairing.lastAddress.port) } - pairing.lastAddress
        val tried = when {
            known.isEmpty() -> last
            else -> dial(known, key, pairing.macFingerprint, source = "known host").orFailures(last)
        }
        if (tried is Dial.Opened) return tried
        if (!reconnecting) show(LinkState.Searching)
        val found = discovery.discover() - pairing.lastAddress - known.toSet()
        if (found.isEmpty()) {
            logger.info("Bonjour found no other address to try")
            return tried
        }
        if (!reconnecting) show(LinkState.Connecting)
        return dial(found, key, pairing.macFingerprint, source = "Bonjour").orFailures(tried)
    }

    private suspend fun pairedSession(dial: Dial.Opened, pairing: StoredPairing): SessionEnd {
        val connection = dial.connection
        return try {
            pairedConversation(dial, pairing).also { end ->
                logger.info("Connection to ${dial.address.host}:${dial.address.port} ended: $end")
            }
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
                            pairingStore.save(
                                pairing.copy(
                                    macName = message.macName,
                                    lastAddress = dial.address,
                                    knownHosts = message.addresses,
                                ),
                            )
                            connected.set(connection)
                            val now = LinkState.Connected(message.deviceId, message.macName)
                            mutableLastConnected.value = now
                            show(now)
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
        logger.info("The Mac closed the connection with $code")
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
                PairingEnd.Accepted -> stayConnected(wasConnected = false)
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
        val direct = dial(listOf(invited), key, invite.fingerprint, source = "invite")
        if (direct is Dial.Opened) return direct
        show(LinkState.Searching)
        val found = discovery.discover() - invited
        if (found.isEmpty()) return direct
        show(LinkState.Connecting)
        return dial(found, key, invite.fingerprint, source = "Bonjour").orFailures(direct)
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
                        pairingStore.save(
                            StoredPairing(invite.fingerprint, message.deviceId, message.macName, dial.address, message.addresses),
                        )
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

    /** Tries [candidates] in turn; [source] says where they came from, for the log. */
    private suspend fun dial(candidates: List<MacAddress>, key: DeviceKey, fingerprint: String, source: String): Dial {
        val failures = mutableSetOf<TransportFailure>()
        for (address in candidates) {
            logger.info("Dialling ${address.host}:${address.port} ($source), pinning ${shortFingerprint(fingerprint)}")
            val connection = transport.open(address, key, fingerprint)
            var failure: TransportFailure? = null
            try {
                when (val event = connection.events.receiveCatching().getOrNull()) {
                    TransportEvent.Opened -> Unit
                    is TransportEvent.Failed -> failure = event.failure
                    else -> failure = TransportFailure.Unreachable
                }
            } finally {
                if (failure != null) connection.close(1000, "Not used")
            }
            if (failure == null) {
                logger.info("Opened ${address.host}:${address.port} ($source)")
                return Dial.Opened(connection, address)
            }
            failures += failure
            logger.warn("Dialling ${address.host}:${address.port} ($source) failed: $failure")
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
        mutableLastConnected.value = null
        show(LinkState.PairFailed(failure))
    }

    private suspend fun unpairRevoked() {
        identity.delete()
        pairingStore.clear()
        mutableLastConnected.value = null
        show(LinkState.NotPaired)
    }

    private suspend fun lock(goal: Goal) {
        goalAfterUnlock = goal
        show(LinkState.Locked)
    }

    private suspend fun show(state: LinkState) {
        currentCoroutineContext().ensureActive()
        setState(state)
    }

    private fun setState(state: LinkState) {
        if (mutableState.value != state) logger.info("State: $state")
        mutableState.value = state
    }

    /** A backoff wait under way; [reconnecting] when the link had been connected before it. */
    private class PendingRedial(val reconnecting: Boolean)

    private sealed interface Goal {
        /** [reconnecting] keeps the connected screens up (as [LinkState.Reconnecting]) while it dials. */
        data class StayConnected(val reconnecting: Boolean = false) : Goal
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
