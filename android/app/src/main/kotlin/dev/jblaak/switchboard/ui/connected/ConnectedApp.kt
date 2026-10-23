package dev.jblaak.switchboard.ui.connected

import androidx.compose.animation.AnimatedContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.ui.ask.AskRoute
import dev.jblaak.switchboard.ui.session.SessionRoute
import dev.jblaak.switchboard.ui.sessions.LinkStatus
import dev.jblaak.switchboard.ui.sessions.SessionStatus
import dev.jblaak.switchboard.ui.sessions.SessionsScreen
import dev.jblaak.switchboard.ui.sessions.Waiting
import dev.jblaak.switchboard.ui.sessions.sessionListOf

/**
 * Switchboard on the phone once it is connected: the session list, a session's terminal and its questions, and
 * Ask Patch. It owns its own navigation; the app shell shows it while the link is connected (or reconnecting).
 *
 * [board] must have been created before the link started (see [SessionBoard]). [deviceId] is this phone's, from
 * [LinkState.Connected], and [macName] the Mac's. [onMenuClick] is the session list's menu (pairing and settings).
 */
@Composable
fun ConnectedApp(
    link: PhoneLink,
    board: SessionBoard,
    deviceId: String,
    macName: String,
    onMenuClick: () -> Unit,
) {
    val navigation = remember { ConnectedNavigation() }
    val route by navigation.route.collectAsState()
    AnimatedContent(targetState = route, contentKey = { it::class }, label = "connected route") { current ->
        when (current) {
            ConnectedRoute.Sessions -> SessionsRoute(link, board, deviceId, macName, navigation, onMenuClick)
            is ConnectedRoute.Session -> SessionRoute(
                link = link,
                board = board,
                deviceId = deviceId,
                sessionId = current.sessionId,
                startedIn = current.startedIn,
                questionsOpen = current.questionsOpen,
                onBack = navigation::backToSessions,
            )
            ConnectedRoute.Ask -> AskRoute(
                link = link,
                board = board,
                onSessionStarted = navigation::sessionStarted,
                onClose = navigation::backToSessions,
            )
        }
    }
}

@Composable
private fun SessionsRoute(
    link: PhoneLink,
    board: SessionBoard,
    deviceId: String,
    macName: String,
    navigation: ConnectedNavigation,
    onMenuClick: () -> Unit,
) {
    val sessions by board.sessions.collectAsState()
    val pending by board.pending.collectAsState()
    val linkState by link.state.collectAsState()
    SessionsScreen(
        list = sessionListOf(sessions, pending, deviceId),
        macName = macName,
        linkStatus = when (linkState) {
            is LinkState.Connected -> LinkStatus.Connected
            LinkState.Reconnecting, LinkState.Connecting, LinkState.Searching -> LinkStatus.Reconnecting
            else -> LinkStatus.Offline
        },
        onSessionClick = { row ->
            val answering = row.status == SessionStatus.NeedsYou && row.waiting is Waiting.Questions
            navigation.sessionOpened(row.id, questionsOpen = answering)
        },
        onAskPatchClick = navigation::askOpened,
        onMenuClick = onMenuClick,
    )
}
