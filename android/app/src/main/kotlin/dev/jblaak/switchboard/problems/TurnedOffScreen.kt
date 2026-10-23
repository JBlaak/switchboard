package dev.jblaak.switchboard.problems

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.MessageScreen
import dev.jblaak.switchboard.components.PrimaryButton
import dev.jblaak.switchboard.components.StatusBadge
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** Phone access was turned off on the Mac. */
@Composable
fun TurnedOffScreen(macName: String?, onTryAgain: () -> Unit) {
    MessageScreen(
        badge = { StatusBadge(icon = R.drawable.ic_power, colors = SwitchboardTheme.colors.pinned) },
        title = stringResource(R.string.turned_off_title),
        description = macName?.let { stringResource(R.string.turned_off_description_named, it) }
            ?: stringResource(R.string.turned_off_description),
        details = null,
        actions = {
            PrimaryButton(text = stringResource(R.string.try_again), onClick = onTryAgain)
        },
    )
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun TurnedOffScreenPreview() {
    SwitchboardTheme {
        TurnedOffScreen(macName = "joris-mbp", onTryAgain = {})
    }
}
