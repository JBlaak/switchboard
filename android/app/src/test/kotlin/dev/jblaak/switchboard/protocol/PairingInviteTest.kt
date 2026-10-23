package dev.jblaak.switchboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingInviteTest {

    private val fingerprint = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

    @Test
    fun `an invite reads into its parts`() {
        /* Given */
        val text = "switchboard://pair?v=1&fp=$fingerprint&code=482913&host=joris-mbp.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertEquals(
            PairingInvite(protocol = 1, fingerprint = fingerprint, code = "482913", host = "joris-mbp.local", port = 48211),
            invite,
        )
    }

    @Test
    fun `the parameters may come in any order`() {
        /* Given */
        val text = "switchboard://pair?port=48211&host=joris-mbp.local&code=482913&fp=$fingerprint&v=1"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertEquals(48211, invite?.port)
    }

    @Test
    fun `percent-encoded values are decoded`() {
        /* Given */
        val text = "switchboard://pair?v=1&fp=$fingerprint&code=48%2013&host=Joris%E2%80%99s-Mac.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertEquals("Joris’s-Mac.local", invite?.host)
    }

    @Test
    fun `an uppercase fingerprint is read as lowercase`() {
        /* Given */
        val text = "switchboard://pair?v=1&fp=${fingerprint.uppercase()}&code=482913&host=h.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertEquals(fingerprint, invite?.fingerprint)
    }

    @Test
    fun `another app's link is not an invite`() {
        /* Given */
        val text = "james://pair?v=1&fp=$fingerprint&code=482913&host=h.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertNull(invite)
    }

    @Test
    fun `an invite without a code is unreadable`() {
        /* Given */
        val text = "switchboard://pair?v=1&fp=$fingerprint&host=h.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertNull(invite)
    }

    @Test
    fun `a fingerprint that is not a SHA-256 is unreadable`() {
        /* Given */
        val text = "switchboard://pair?v=1&fp=9f:86:d0&code=482913&host=h.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertNull(invite)
    }

    @Test
    fun `a port out of range is unreadable`() {
        /* Given */
        val text = "switchboard://pair?v=1&fp=$fingerprint&code=482913&host=h.local&port=70000"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertNull(invite)
    }

    @Test
    fun `a version that is not a number is unreadable`() {
        /* Given */
        val text = "switchboard://pair?v=one&fp=$fingerprint&code=482913&host=h.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertNull(invite)
    }

    @Test
    fun `a broken percent escape is unreadable`() {
        /* Given */
        val text = "switchboard://pair?v=1&fp=$fingerprint&code=48%2&host=h.local&port=48211"

        /* When */
        val invite = PairingInvite.parseOrNull(text)

        /* Then */
        assertNull(invite)
    }
}
