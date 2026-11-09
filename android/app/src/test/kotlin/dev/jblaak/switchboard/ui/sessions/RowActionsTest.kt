package dev.jblaak.switchboard.ui.sessions

import androidx.compose.material3.SwipeToDismissBoxValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RowActionsTest {

    @Test
    fun `a swipe towards the start archives`() {
        /* When */
        val action = swipeActionOf(SwipeToDismissBoxValue.EndToStart, pinned = false)

        /* Then */
        assertEquals(RowAction.Archive, action)
    }

    @Test
    fun `a swipe towards the end pins a row that isn't pinned`() {
        /* When */
        val action = swipeActionOf(SwipeToDismissBoxValue.StartToEnd, pinned = false)

        /* Then */
        assertEquals(RowAction.Pin, action)
    }

    @Test
    fun `a swipe towards the end unpins a pinned row`() {
        /* When */
        val action = swipeActionOf(SwipeToDismissBoxValue.StartToEnd, pinned = true)

        /* Then */
        assertEquals(RowAction.Unpin, action)
    }

    @Test
    fun `a pinned row is still archived by a swipe towards the start`() {
        /* When */
        val action = swipeActionOf(SwipeToDismissBoxValue.EndToStart, pinned = true)

        /* Then */
        assertEquals(RowAction.Archive, action)
    }

    @Test
    fun `a settled row does nothing`() {
        /* When */
        val action = swipeActionOf(SwipeToDismissBoxValue.Settled, pinned = false)

        /* Then */
        assertNull(action)
    }

    @Test
    fun `a rename is trimmed`() {
        /* When */
        val name = renamedOrNull("  Login fix \n", current = "Fix the login page")

        /* Then */
        assertEquals("Login fix", name)
    }

    @Test
    fun `an empty rename is not sent`() {
        /* When */
        val name = renamedOrNull("   ", current = "Fix the login page")

        /* Then */
        assertNull(name)
    }

    @Test
    fun `a rename to the name it has is not sent`() {
        /* When */
        val name = renamedOrNull("Fix the login page ", current = "Fix the login page")

        /* Then */
        assertNull(name)
    }

    @Test
    fun `a rename longer than the Mac takes is not sent`() {
        /* When */
        val name = renamedOrNull("x".repeat(MAX_SESSION_NAME + 1), current = "Fix the login page")

        /* Then */
        assertNull(name)
    }
}
