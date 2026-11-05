package dev.jblaak.switchboard.link.network

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DefaultNetworkTrackerTest {

    private val tracker = DefaultNetworkTracker()

    @Test
    fun `the first default network is a change`() {
        /* Given */
        val addresses = setOf("192.168.1.50")

        /* When */
        val changed = tracker.linkPropertiesChanged("100", addresses)

        /* Then */
        assertTrue(changed)
    }

    @Test
    fun `the same network with the same addresses is not a change`() {
        /* Given */
        tracker.linkPropertiesChanged("100", setOf("192.168.1.50"))

        /* When */
        val changed = tracker.linkPropertiesChanged("100", setOf("192.168.1.50"))

        /* Then */
        assertFalse(changed)
    }

    @Test
    fun `new addresses on the same network are a change`() {
        /* Given */
        tracker.linkPropertiesChanged("100", setOf("192.168.1.50"))

        /* When */
        val changed = tracker.linkPropertiesChanged("100", setOf("192.168.1.77"))

        /* Then */
        assertTrue(changed)
    }

    @Test
    fun `another network taking over is a change`() {
        /* Given */
        tracker.linkPropertiesChanged("100", setOf("192.168.1.50"))

        /* When */
        val changed = tracker.linkPropertiesChanged("101", setOf("10.20.30.40"))

        /* Then */
        assertTrue(changed)
    }

    @Test
    fun `losing the default network is a change`() {
        /* Given */
        tracker.linkPropertiesChanged("100", setOf("192.168.1.50"))

        /* When */
        val changed = tracker.lost("100")

        /* Then */
        assertTrue(changed)
    }

    @Test
    fun `losing a network that isn't the default is not a change`() {
        /* Given */
        tracker.linkPropertiesChanged("101", setOf("10.20.30.40"))

        /* When */
        val changed = tracker.lost("100")

        /* Then */
        assertFalse(changed)
    }
}
