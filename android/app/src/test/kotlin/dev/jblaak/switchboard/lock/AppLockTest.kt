package dev.jblaak.switchboard.lock

import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {

    @Test
    fun `the app opens locked`() {
        /* Given */
        val lock = AppLock(timeout = 5.minutes)

        /* When */
        val isLocked = lock.isLocked

        /* Then */
        assertTrue(isLocked)
    }

    @Test
    fun `an unlock opens it`() {
        /* Given */
        val lock = AppLock(timeout = 5.minutes)

        /* When */
        lock.unlocked()

        /* Then */
        assertFalse(lock.isLocked)
    }

    @Test
    fun `five minutes in the background locks it`() {
        /* Given */
        val lock = AppLock(timeout = 5.minutes).also { it.unlocked() }
        lock.backgrounded(at = 1.minutes)

        /* When */
        lock.foregrounded(at = 6.minutes)

        /* Then */
        assertTrue(lock.isLocked)
    }

    @Test
    fun `a shorter trip to the background leaves it open`() {
        /* Given */
        val lock = AppLock(timeout = 5.minutes).also { it.unlocked() }
        lock.backgrounded(at = 1.minutes)

        /* When */
        lock.foregrounded(at = 5.minutes + 59.seconds)

        /* Then */
        assertFalse(lock.isLocked)
    }

    @Test
    fun `coming to the foreground without having left leaves it open`() {
        /* Given */
        val lock = AppLock(timeout = 5.minutes).also { it.unlocked() }

        /* When */
        lock.foregrounded(at = 60.minutes)

        /* Then */
        assertFalse(lock.isLocked)
    }

    @Test
    fun `each trip to the background is timed on its own`() {
        /* Given */
        val lock = AppLock(timeout = 5.minutes).also { it.unlocked() }
        lock.backgrounded(at = 0.minutes)
        lock.foregrounded(at = 4.minutes)
        lock.backgrounded(at = 8.minutes)

        /* When */
        lock.foregrounded(at = 10.minutes)

        /* Then */
        assertFalse(lock.isLocked)
    }
}
