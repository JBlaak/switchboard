package dev.jblaak.switchboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloseReasonTest {

    @Test
    fun `a known close code maps to its reason`() {
        /* Given */
        val code = 4003

        /* When */
        val reason = CloseReason.fromCodeOrNull(code)

        /* Then */
        assertEquals(CloseReason.NotPaired, reason)
    }

    @Test
    fun `a normal closure has no reason of its own`() {
        /* Given */
        val code = 1000

        /* When */
        val reason = CloseReason.fromCodeOrNull(code)

        /* Then */
        assertNull(reason)
    }
}
