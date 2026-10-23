package dev.jblaak.switchboard.shell

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.PairFailure
import dev.jblaak.switchboard.lock.AppLock
import dev.jblaak.switchboard.protocol.PROTOCOL_VERSION
import dev.jblaak.switchboard.protocol.PairRejection
import dev.jblaak.switchboard.protocol.PairingInvite
import kotlin.time.Duration.Companion.minutes
import org.junit.Assert.assertEquals
import org.junit.Test

class AppScreenModelTest {

    private val invite = PairingInvite(
        protocol = PROTOCOL_VERSION,
        fingerprint = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        code = "482913",
        host = "joris-mbp.local",
        port = 48211,
    )

    private fun unlockedModel(knownMacName: String? = "joris-mbp"): AppScreenModel {
        return AppScreenModel(appVersion = "0.1.0", knownMacName = knownMacName, lock = AppLock(timeout = 5.minutes))
            .also { it.unlocked() }
    }

    @Test
    fun `before the link says anything the app shows the starting screen`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        val screen = model.screen.value

        /* Then */
        assertEquals(AppScreen.Starting, screen)
    }

    @Test
    fun `an idle link shows the starting screen`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.Connecting)

        /* When */
        model.linkChanged(LinkState.Idle)

        /* Then */
        assertEquals(AppScreen.Starting, model.screen.value)
    }

    @Test
    fun `an unpaired link shows the camera without a way back`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.linkChanged(LinkState.Unpaired)

        /* Then */
        assertEquals(AppScreen.Scan(canGoBack = false), model.screen.value)
    }

    @Test
    fun `searching for the paired Mac shows connecting with its stored name`() {
        /* Given */
        val model = unlockedModel(knownMacName = "joris-mbp")

        /* When */
        model.linkChanged(LinkState.Searching)

        /* Then */
        assertEquals(AppScreen.Connecting("joris-mbp"), model.screen.value)
    }

    @Test
    fun `connecting to the paired Mac shows connecting`() {
        /* Given */
        val model = unlockedModel(knownMacName = null)

        /* When */
        model.linkChanged(LinkState.Connecting)

        /* Then */
        assertEquals(AppScreen.Connecting(null), model.screen.value)
    }

    @Test
    fun `a connected link shows the connected screens`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))

        /* Then */
        assertEquals(AppScreen.Connected, model.screen.value)
    }

    @Test
    fun `reconnecting after a drop keeps the connected screens`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))

        /* When */
        model.linkChanged(LinkState.Reconnecting)

        /* Then */
        assertEquals(AppScreen.Connected, model.screen.value)
    }

    @Test
    fun `reconnecting without having been connected shows connecting`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.Connecting)

        /* When */
        model.linkChanged(LinkState.Reconnecting)

        /* Then */
        assertEquals(AppScreen.Connecting("joris-mbp"), model.screen.value)
    }

    @Test
    fun `a Mac that cannot be found shows not found`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.linkChanged(LinkState.NotFound)

        /* Then */
        assertEquals(AppScreen.NotFound("joris-mbp", isTrying = false), model.screen.value)
    }

    @Test
    fun `retrying from not found stays on not found while it tries`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.NotFound)

        /* When */
        model.linkChanged(LinkState.Searching)

        /* Then */
        assertEquals(AppScreen.NotFound("joris-mbp", isTrying = true), model.screen.value)
    }

    @Test
    fun `a retry that finds nothing again settles back on not found`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.NotFound)
        model.linkChanged(LinkState.Connecting)

        /* When */
        model.linkChanged(LinkState.NotFound)

        /* Then */
        assertEquals(AppScreen.NotFound("joris-mbp", isTrying = false), model.screen.value)
    }

    @Test
    fun `a retry that connects leaves not found`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.NotFound)
        model.linkChanged(LinkState.Connecting)

        /* When */
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))

        /* Then */
        assertEquals(AppScreen.Connected, model.screen.value)
    }

    @Test
    fun `a revoked phone shows not paired`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.linkChanged(LinkState.NotPaired)

        /* Then */
        assertEquals(AppScreen.NotPaired("joris-mbp"), model.screen.value)
    }

    @Test
    fun `a protocol mismatch shows both versions`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.linkChanged(LinkState.UpdateRequired(macVersion = "2.9.0"))

        /* Then */
        assertEquals(AppScreen.UpdateRequired(macVersion = "2.9.0", appVersion = "0.1.0"), model.screen.value)
    }

    @Test
    fun `phone access turned off on the Mac shows turned off`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.linkChanged(LinkState.TurnedOff)

        /* Then */
        assertEquals(AppScreen.TurnedOff("joris-mbp"), model.screen.value)
    }

    @Test
    fun `a locked key shows the lock even after the app was unlocked`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.linkChanged(LinkState.Locked)

        /* Then */
        assertEquals(AppScreen.Locked("joris-mbp"), model.screen.value)
    }

    @Test
    fun `a failed pairing shows why`() {
        /* Given */
        val model = unlockedModel()
        val failure = PairFailure.Rejected(PairRejection.Expired)

        /* When */
        model.linkChanged(LinkState.PairFailed(failure))

        /* Then */
        assertEquals(AppScreen.PairFailed(failure), model.screen.value)
    }

    @Test
    fun `starting to pair shows the checklist looking for the invite's host`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.Unpaired)

        /* When */
        model.pairingStarted(invite)

        /* Then */
        assertEquals(AppScreen.Confirm("joris-mbp.local", PairingStep.Finding), model.screen.value)
    }

    @Test
    fun `searching while pairing stays on the checklist`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.Unpaired)
        model.pairingStarted(invite)

        /* When */
        model.linkChanged(LinkState.Searching)

        /* Then */
        assertEquals(AppScreen.Confirm("joris-mbp.local", PairingStep.Finding), model.screen.value)
    }

    @Test
    fun `the Mac opening a pairing connection ticks off finding it`() {
        /* Given */
        val model = unlockedModel()
        model.pairingStarted(invite)

        /* When */
        model.linkChanged(LinkState.Pairing(macName = "joris-mbp"))

        /* Then */
        assertEquals(AppScreen.Confirm("joris-mbp.local", PairingStep.CheckingCode), model.screen.value)
    }

    @Test
    fun `a pending pairing waits on the Mac`() {
        /* Given */
        val model = unlockedModel()
        model.pairingStarted(invite)
        model.linkChanged(LinkState.Pairing(macName = "joris-mbp"))

        /* When */
        model.linkChanged(LinkState.PairPending(macName = "joris-mbp"))

        /* Then */
        assertEquals(AppScreen.Confirm("joris-mbp.local", PairingStep.WaitingOnMac), model.screen.value)
    }

    @Test
    fun `connecting after the Mac accepted keeps the finished checklist until connected`() {
        /* Given */
        val model = unlockedModel()
        model.pairingStarted(invite)
        model.linkChanged(LinkState.PairPending(macName = "joris-mbp"))

        /* When */
        model.linkChanged(LinkState.Connecting)

        /* Then */
        assertEquals(AppScreen.Confirm("joris-mbp.local", PairingStep.WaitingOnMac), model.screen.value)
    }

    @Test
    fun `once paired a later reconnect shows connecting, not the checklist`() {
        /* Given */
        val model = unlockedModel()
        model.pairingStarted(invite)
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))
        model.linkChanged(LinkState.NotFound)

        /* When */
        model.linkChanged(LinkState.Idle)
        model.linkChanged(LinkState.Connecting)

        /* Then */
        assertEquals(AppScreen.Connecting("joris-mbp"), model.screen.value)
    }

    @Test
    fun `an invite for another protocol fails at once`() {
        /* Given */
        val model = unlockedModel()

        /* When */
        model.pairingStarted(invite.copy(protocol = PROTOCOL_VERSION + 1))

        /* Then */
        assertEquals(AppScreen.PairFailed(PairFailure.ProtocolMismatch(PROTOCOL_VERSION + 1)), model.screen.value)
    }

    @Test
    fun `pair again opens the camera over not paired`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.NotPaired)

        /* When */
        model.scanRequested()

        /* Then */
        assertEquals(AppScreen.Scan(canGoBack = true), model.screen.value)
    }

    @Test
    fun `backing out of the camera returns to the failure`() {
        /* Given */
        val model = unlockedModel()
        val failure = PairFailure.Interrupted
        model.linkChanged(LinkState.PairFailed(failure))
        model.scanRequested()

        /* When */
        model.scanDismissed()

        /* Then */
        assertEquals(AppScreen.PairFailed(failure), model.screen.value)
    }

    @Test
    fun `a new link state closes a camera opened over the old one`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.NotPaired)
        model.scanRequested()

        /* When */
        model.linkChanged(LinkState.Unpaired)

        /* Then */
        assertEquals(AppScreen.Scan(canGoBack = false), model.screen.value)
    }

    @Test
    fun `the Mac's name is remembered from the connection`() {
        /* Given */
        val model = unlockedModel(knownMacName = null)
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "studio"))

        /* When */
        model.linkChanged(LinkState.NotFound)

        /* Then */
        assertEquals(AppScreen.NotFound("studio", isTrying = false), model.screen.value)
    }

    @Test
    fun `forgetting the Mac forgets its name`() {
        /* Given */
        val model = unlockedModel(knownMacName = "joris-mbp")
        model.linkChanged(LinkState.Unpaired)

        /* When */
        model.linkChanged(LinkState.NotFound)

        /* Then */
        assertEquals(AppScreen.NotFound(null, isTrying = false), model.screen.value)
    }

    @Test
    fun `the app opens locked over the paired screens`() {
        /* Given */
        val model = AppScreenModel(appVersion = "0.1.0", knownMacName = "joris-mbp", lock = AppLock(timeout = 5.minutes))

        /* When */
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))

        /* Then */
        assertEquals(AppScreen.Locked("joris-mbp"), model.screen.value)
    }

    @Test
    fun `the open lock leaves the pair screen alone`() {
        /* Given */
        val model = AppScreenModel(appVersion = "0.1.0", knownMacName = null, lock = AppLock(timeout = 5.minutes))

        /* When */
        model.linkChanged(LinkState.Unpaired)

        /* Then */
        assertEquals(AppScreen.Scan(canGoBack = false), model.screen.value)
    }

    @Test
    fun `unlocking shows the screen under the lock`() {
        /* Given */
        val model = AppScreenModel(appVersion = "0.1.0", knownMacName = "joris-mbp", lock = AppLock(timeout = 5.minutes))
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))

        /* When */
        model.unlocked()

        /* Then */
        assertEquals(AppScreen.Connected, model.screen.value)
    }

    @Test
    fun `coming back after five minutes in the background locks again`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))
        model.backgrounded(at = 10.minutes)

        /* When */
        model.foregrounded(at = 15.minutes)

        /* Then */
        assertEquals(AppScreen.Locked("joris-mbp"), model.screen.value)
    }

    @Test
    fun `coming back sooner stays unlocked`() {
        /* Given */
        val model = unlockedModel()
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))
        model.backgrounded(at = 10.minutes)

        /* When */
        model.foregrounded(at = 14.minutes)

        /* Then */
        assertEquals(AppScreen.Connected, model.screen.value)
    }

    @Test
    fun `the unlock before pairing unlocks the app`() {
        /* Given */
        val model = AppScreenModel(appVersion = "0.1.0", knownMacName = null, lock = AppLock(timeout = 5.minutes))
        model.linkChanged(LinkState.Unpaired)
        model.pairingStarted(invite)

        /* When */
        model.linkChanged(LinkState.Connected(deviceId = "d1", macName = "joris-mbp"))

        /* Then */
        assertEquals(AppScreen.Connected, model.screen.value)
    }
}
