package dev.jblaak.switchboard.ui.connected

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectedNavigationTest {

    private val navigation = ConnectedNavigation()

    @Test
    fun `answering from the list opens the session with its questions up`() {
        /* Given */
        val sessionId = "s-1"

        /* When */
        navigation.sessionOpened(sessionId, questionsOpen = true)

        /* Then */
        assertEquals(ConnectedRoute.Session("s-1", startedIn = null, questionsOpen = true), navigation.route.value)
    }

    @Test
    fun `a session Ask Patch started replaces Ask Patch`() {
        /* Given */
        navigation.askOpened()

        /* When */
        navigation.sessionStarted("s-9", "switchboard")

        /* Then */
        assertEquals(ConnectedRoute.Session("s-9", startedIn = "switchboard", questionsOpen = false), navigation.route.value)
    }

    @Test
    fun `back from a session is the list`() {
        /* Given */
        navigation.sessionOpened("s-1", questionsOpen = false)

        /* When */
        navigation.backToSessions()

        /* Then */
        assertEquals(ConnectedRoute.Sessions, navigation.route.value)
    }

    @Test
    fun `archiving the open session goes back to the list`() {
        /* Given */
        navigation.sessionOpened("s-1", questionsOpen = false)

        /* When */
        navigation.sessionArchived("s-1")

        /* Then */
        assertEquals(ConnectedRoute.Sessions, navigation.route.value)
    }

    @Test
    fun `archiving a session that is no longer open leaves the screen alone`() {
        /* Given */
        navigation.askOpened()

        /* When */
        navigation.sessionArchived("s-1")

        /* Then */
        assertEquals(ConnectedRoute.Ask, navigation.route.value)
    }
}
