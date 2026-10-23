package dev.jblaak.switchboard.problems

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.DetailsCard
import dev.jblaak.switchboard.components.MessageScreen
import dev.jblaak.switchboard.components.PrimaryButton
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** "Can't find your Mac": the three things to check, and Try now. The shell retries on its own meanwhile. */
@Composable
fun NotFoundScreen(macName: String?, isTrying: Boolean, onTryNow: () -> Unit) {
    MessageScreen(
        badge = { WifiOffBadge() },
        title = macName?.let { stringResource(R.string.not_found_title_named, it) }
            ?: stringResource(R.string.not_found_title),
        description = stringResource(R.string.not_found_description),
        details = {
            DetailsCard {
                Check(number = 1, text = R.string.not_found_check_network)
                Check(number = 2, text = R.string.not_found_check_awake)
                Check(number = 3, text = R.string.not_found_check_phone_access)
            }
        },
        actions = {
            Text(
                text = stringResource(if (isTrying) R.string.not_found_looking else R.string.not_found_retrying),
                modifier = Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.bodySmall,
                color = SwitchboardTheme.colors.textMuted,
                textAlign = TextAlign.Center,
            )
            PrimaryButton(text = stringResource(R.string.not_found_try_now), onClick = onTryNow)
        },
    )
}

@Composable
private fun WifiOffBadge() {
    Box(
        modifier = Modifier
            .size(112.dp)
            .background(SwitchboardTheme.colors.bgPanel, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(R.drawable.ic_wifi),
            contentDescription = null,
            modifier = Modifier.size(52.dp),
            tint = SwitchboardTheme.colors.textMuted,
        )
        Icon(
            painter = painterResource(R.drawable.ic_slash),
            contentDescription = null,
            modifier = Modifier.size(52.dp),
            tint = SwitchboardTheme.colors.needsYou.ink,
        )
    }
}

@Composable
private fun Check(number: Int, @StringRes text: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            text = number.toString(),
            style = MaterialTheme.typography.labelLarge,
            color = SwitchboardTheme.colors.accent,
        )
        Text(
            text = stringResource(text),
            style = MaterialTheme.typography.bodyMedium,
            color = SwitchboardTheme.colors.textDim,
        )
    }
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun NotFoundScreenPreview() {
    SwitchboardTheme {
        NotFoundScreen(macName = "joris-mbp", isTrying = false, onTryNow = {})
    }
}

@Preview(name = "Trying, dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Trying, light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun NotFoundScreenTryingPreview() {
    SwitchboardTheme {
        NotFoundScreen(macName = null, isTrying = true, onTryNow = {})
    }
}
