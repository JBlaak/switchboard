package dev.jblaak.switchboard.pair

import dev.jblaak.switchboard.protocol.PairingInvite
import org.junit.Assert.assertEquals
import org.junit.Test

class InviteScannerTest {

    private val inviteText =
        "switchboard://pair?v=1&fp=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" +
            "&code=482913&host=joris-mbp.local&port=48211"

    @Test
    fun `an invite in the frame is found`() {
        /* Given */
        val scanner = InviteScanner()

        /* When */
        val outcome = scanner.scanned(listOf(inviteText))

        /* Then */
        assertEquals(ScanOutcome.Found(PairingInvite.parseOrNull(inviteText)!!), outcome)
    }

    @Test
    fun `a QR code that is not an invite is reported as such`() {
        /* Given */
        val scanner = InviteScanner()

        /* When */
        val outcome = scanner.scanned(listOf("https://example.com/menu"))

        /* Then */
        assertEquals(ScanOutcome.NotSwitchboard, outcome)
    }

    @Test
    fun `a QR code that is not an invite raises the hint`() {
        /* Given */
        val scanner = InviteScanner()

        /* When */
        scanner.scanned(listOf("https://example.com/menu"))

        /* Then */
        assertEquals(ScanHint.NotSwitchboard, scanner.hint.value)
    }

    @Test
    fun `scanning goes on after a QR code that is not an invite`() {
        /* Given */
        val scanner = InviteScanner()
        scanner.scanned(listOf("https://example.com/menu"))

        /* When */
        val outcome = scanner.scanned(listOf(inviteText))

        /* Then */
        assertEquals(ScanOutcome.Found(PairingInvite.parseOrNull(inviteText)!!), outcome)
    }

    @Test
    fun `finding an invite clears the hint`() {
        /* Given */
        val scanner = InviteScanner()
        scanner.scanned(listOf("https://example.com/menu"))

        /* When */
        scanner.scanned(listOf(inviteText))

        /* Then */
        assertEquals(ScanHint.HoldSteady, scanner.hint.value)
    }

    @Test
    fun `an invite beside another code in the same frame is found`() {
        /* Given */
        val scanner = InviteScanner()

        /* When */
        val outcome = scanner.scanned(listOf("WIFI:S:home;;", inviteText))

        /* Then */
        assertEquals(ScanOutcome.Found(PairingInvite.parseOrNull(inviteText)!!), outcome)
    }

    @Test
    fun `the invite is found once while the camera keeps seeing it`() {
        /* Given */
        val scanner = InviteScanner()
        scanner.scanned(listOf(inviteText))

        /* When */
        val outcome = scanner.scanned(listOf(inviteText))

        /* Then */
        assertEquals(ScanOutcome.Ignored, outcome)
    }

    @Test
    fun `resuming finds the invite again`() {
        /* Given */
        val scanner = InviteScanner()
        scanner.scanned(listOf(inviteText))

        /* When */
        scanner.resume()

        /* Then */
        assertEquals(ScanOutcome.Found(PairingInvite.parseOrNull(inviteText)!!), scanner.scanned(listOf(inviteText)))
    }

    @Test
    fun `a frame without codes is ignored`() {
        /* Given */
        val scanner = InviteScanner()

        /* When */
        val outcome = scanner.scanned(emptyList())

        /* Then */
        assertEquals(ScanOutcome.Ignored, outcome)
    }
}
