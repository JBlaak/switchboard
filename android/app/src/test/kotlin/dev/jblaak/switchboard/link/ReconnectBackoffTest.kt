package dev.jblaak.switchboard.link

import kotlin.time.Duration.Companion.seconds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReconnectBackoffTest {

    private val backoff = ReconnectBackoff(first = 1.seconds, cap = 10.seconds, attempts = 8)

    @Test
    fun `the delay doubles up to the cap`() {
        /* Given */
        val attempts = 0 until 8

        /* When */
        val delays = attempts.map { backoff.delayBeforeOrNull(it) }

        /* Then */
        assertEquals(listOf(1, 2, 4, 8, 10, 10, 10, 10).map { it.seconds }, delays)
    }

    @Test
    fun `there is no delay once the attempts are used up`() {
        /* Given */
        val attempt = 8

        /* When */
        val delay = backoff.delayBeforeOrNull(attempt)

        /* Then */
        assertNull(delay)
    }
}
