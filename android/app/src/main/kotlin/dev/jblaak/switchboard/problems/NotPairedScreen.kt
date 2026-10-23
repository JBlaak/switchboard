package dev.jblaak.switchboard.problems

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.MessageScreen
import dev.jblaak.switchboard.components.PrimaryButton
import dev.jblaak.switchboard.components.QuietButton
import dev.jblaak.switchboard.components.StatusBadge
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** The Mac revoked this phone or reset its identity: pair again, or forget it. */
@Composable
fun NotPairedScreen(macName: String?, onPairAgain: () -> Unit, onForget: () -> Unit) {
    MessageScreen(
        badge = { StatusBadge(icon = R.drawable.ic_link_broken, colors = SwitchboardTheme.colors.needsYou) },
        title = stringResource(R.string.not_paired_title),
        description = macName?.let { stringResource(R.string.not_paired_description_named, it) }
            ?: stringResource(R.string.not_paired_description),
        details = null,
        actions = {
            PrimaryButton(text = stringResource(R.string.not_paired_pair_again), onClick = onPairAgain)
            QuietButton(text = stringResource(R.string.not_paired_forget), onClick = onForget)
        },
    )
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun NotPairedScreenPreview() {
    SwitchboardTheme {
        NotPairedScreen(macName = "joris-mbp", onPairAgain = {}, onForget = {})
    }
}
