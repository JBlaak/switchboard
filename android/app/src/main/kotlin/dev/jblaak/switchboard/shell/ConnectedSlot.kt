package dev.jblaak.switchboard.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.MacLink
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.ConnectedApp
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.voice.VoiceControls
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay

/** A reconnect that is over sooner than this (a Mac restarting its listener, a quick hand-over) shows no strip. */
private val STRIP_AFTER = 1.seconds

/**
 * What the shell shows while the link is connected, or reconnecting after it was: the connected app, kept on the
 * link's last connection (or the stored pairing) so it never goes blank, with a "Reconnecting…" strip on top while
 * the link is down so the user knows the list may be stale. The session list's menu asks before forgetting the Mac,
 * the one thing it offers so far.
 */
@Composable
fun ConnectedSlot(link: MacLink, phoneLink: PhoneLink, board: SessionBoard, voice: VoiceControls) {
    val state by link.state.collectAsState()
    val lastConnected by link.lastConnected.collectAsState()
    val stored = remember { link.lastConnectedOrStored() }
    val connected = lastConnected ?: stored
    if (connected == null) {
        // Not paired at all: the shell moves on to the pair screen in a moment.
        ConnectingScreen(macName = null)
        return
    }
    var confirmingForget by rememberSaveable { mutableStateOf(false) }
    var showsStrip by remember { mutableStateOf(false) }
    val isDown = state !is LinkState.Connected
    LaunchedEffect(isDown) {
        if (isDown) delay(STRIP_AFTER)
        showsStrip = isDown
    }

    Column(Modifier.fillMaxSize().background(SwitchboardTheme.colors.bgBase)) {
        if (showsStrip) ReconnectingStrip(macName = connected.macName)
        Box(
            Modifier
                .weight(1f)
                .then(if (showsStrip) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier),
        ) {
            ConnectedApp(
                link = phoneLink,
                board = board,
                voice = voice,
                deviceId = connected.deviceId,
                macName = connected.macName,
                onMenuClick = { confirmingForget = true },
            )
        }
    }

    if (confirmingForget) {
        AlertDialog(
            onDismissRequest = { confirmingForget = false },
            title = { Text(stringResource(R.string.forget_mac_title, connected.macName)) },
            text = { Text(stringResource(R.string.forget_mac_body)) },
            confirmButton = {
                TextButton(onClick = { confirmingForget = false; link.forget() }) {
                    Text(stringResource(R.string.not_paired_forget))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingForget = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

/** A thin line under the status bar, in the reconnecting status's colours: the screens below may be out of date. */
@Composable
private fun ReconnectingStrip(macName: String) {
    val colors = SwitchboardTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.pinned.fill)
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(12.dp),
            color = colors.pinned.ink,
            trackColor = colors.pinned.fill,
            strokeWidth = 1.5.dp,
        )
        Text(
            text = stringResource(R.string.connected_reconnecting, macName),
            style = MaterialTheme.typography.bodySmall,
            color = colors.pinned.ink,
        )
    }
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun ReconnectingStripPreview() {
    SwitchboardTheme {
        ReconnectingStrip(macName = "joris-mbp")
    }
}
