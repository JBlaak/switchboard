package dev.jblaak.switchboard.lock

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** The app's logo and the fingerprint button; the shell shows the prompt on its own as this appears. */
@Composable
fun LockScreen(macName: String?, onUnlock: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SwitchboardTheme.colors.bgBase)
            .safeDrawingPadding()
            .padding(start = 36.dp, end = 36.dp, bottom = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            SwitchboardMark()
            Column(verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = stringResource(R.string.app_name),
                    style = MaterialTheme.typography.headlineMedium,
                    color = SwitchboardTheme.colors.textStrong,
                )
                if (macName != null) {
                    Text(
                        text = stringResource(R.string.lock_paired_with, macName),
                        style = MaterialTheme.typography.bodyLarge,
                        color = SwitchboardTheme.colors.textMuted,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
        UnlockButton(onUnlock)
    }
}

/** The Switchboard mark on its mint tile, shared with the connecting screen. */
@Composable
fun SwitchboardMark() {
    Box(
        modifier = Modifier
            .size(88.dp)
            .background(SwitchboardTheme.colors.running.fill, RoundedCornerShape(26.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(R.drawable.ic_switchboard),
            contentDescription = null,
            modifier = Modifier.size(44.dp),
            tint = SwitchboardTheme.colors.accent,
        )
    }
}

@Composable
private fun UnlockButton(onUnlock: () -> Unit) {
    Column(
        modifier = Modifier
            .clip(MaterialTheme.shapes.large)
            .clickable(role = Role.Button, onClick = onUnlock)
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(72.dp)
                .background(SwitchboardTheme.colors.bgRaised, CircleShape)
                .border(1.dp, SwitchboardTheme.colors.borderStrong, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_fingerprint),
                contentDescription = null,
                modifier = Modifier.size(34.dp),
                tint = SwitchboardTheme.colors.textStrong,
            )
        }
        Text(
            text = stringResource(R.string.lock_unlock),
            style = MaterialTheme.typography.titleSmall,
            color = SwitchboardTheme.colors.textStrong,
        )
    }
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun LockScreenPreview() {
    SwitchboardTheme {
        LockScreen(macName = "joris-mbp.local", onUnlock = {})
    }
}
