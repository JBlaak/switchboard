package dev.jblaak.switchboard.shell

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.MacLink
import dev.jblaak.switchboard.ui.connected.ConnectedApp
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.voice.VoiceControls

/**
 * What the shell shows while the link is connected, or reconnecting after it was: the connected app, kept on
 * the last connection's device id and Mac name through a reconnect so the session list doesn't blink away.
 * The session list's menu asks before forgetting the Mac, the one thing it offers so far.
 */
@Composable
fun ConnectedSlot(link: MacLink, phoneLink: PhoneLink, board: SessionBoard, voice: VoiceControls) {
    val state by link.state.collectAsState()
    val last = remember { mutableStateOf<LinkState.Connected?>(null) }
    (state as? LinkState.Connected)?.let { last.value = it }
    val connected = last.value ?: return
    var confirmingForget by rememberSaveable { mutableStateOf(false) }

    ConnectedApp(
        link = phoneLink,
        board = board,
        voice = voice,
        deviceId = connected.deviceId,
        macName = connected.macName,
        onMenuClick = { confirmingForget = true },
    )

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
