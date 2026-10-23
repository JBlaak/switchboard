package dev.jblaak.switchboard.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.lock.SwitchboardMark
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** Finding and dialling the paired Mac, before the connected screens or a failure take over. */
@Composable
fun ConnectingScreen(macName: String?) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SwitchboardTheme.colors.bgBase)
            .safeDrawingPadding()
            .padding(horizontal = 36.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        SwitchboardMark()
        Text(
            text = macName?.let { stringResource(R.string.connecting_to_mac, it) }
                ?: stringResource(R.string.connecting_to_your_mac),
            style = MaterialTheme.typography.bodyLarge,
            color = SwitchboardTheme.colors.textMuted,
            textAlign = TextAlign.Center,
        )
        CircularProgressIndicator(
            modifier = Modifier.size(24.dp),
            color = SwitchboardTheme.colors.accent,
            trackColor = SwitchboardTheme.colors.borderStrong,
            strokeWidth = 2.5.dp,
        )
    }
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun ConnectingScreenPreview() {
    SwitchboardTheme {
        ConnectingScreen(macName = "joris-mbp")
    }
}
