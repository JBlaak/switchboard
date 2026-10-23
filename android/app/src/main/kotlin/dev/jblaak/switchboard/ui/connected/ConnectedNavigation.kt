package dev.jblaak.switchboard.ui.connected

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Where the connected app is: the session list, with a session or Ask Patch over it. */
class ConnectedNavigation {

    private val mutableRoute = MutableStateFlow<ConnectedRoute>(ConnectedRoute.Sessions)
    val route: StateFlow<ConnectedRoute> = mutableRoute.asStateFlow()

    /** [questionsOpen] opens the session with its question sheet up, from a row's "Answer". */
    fun sessionOpened(sessionId: String, questionsOpen: Boolean) {
        mutableRoute.value = ConnectedRoute.Session(sessionId, startedIn = null, questionsOpen = questionsOpen)
    }

    fun askOpened() {
        mutableRoute.value = ConnectedRoute.Ask
    }

    /** Ask Patch started a session: it replaces Ask Patch, so back goes to the list. */
    fun sessionStarted(sessionId: String, project: String) {
        mutableRoute.value = ConnectedRoute.Session(sessionId, startedIn = project, questionsOpen = false)
    }

    /** Archived from its screen: back to the list, unless something else has been opened meanwhile. */
    fun sessionArchived(sessionId: String) {
        if ((mutableRoute.value as? ConnectedRoute.Session)?.sessionId == sessionId) backToSessions()
    }

    fun backToSessions() {
        mutableRoute.value = ConnectedRoute.Sessions
    }
}

sealed interface ConnectedRoute {
    data object Sessions : ConnectedRoute

    data class Session(val sessionId: String, val startedIn: String?, val questionsOpen: Boolean) : ConnectedRoute

    data object Ask : ConnectedRoute
}
