package dev.jblaak.switchboard.problems

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.DetailsCard
import dev.jblaak.switchboard.components.MessageScreen
import dev.jblaak.switchboard.components.PrimaryButton
import dev.jblaak.switchboard.components.StatusBadge
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** The Mac speaks another protocol: both versions, and the way to the release that matches. */
@Composable
fun UpdateRequiredScreen(macVersion: String?, appVersion: String, onGetRelease: () -> Unit) {
    MessageScreen(
        badge = { StatusBadge(icon = R.drawable.ic_download, colors = SwitchboardTheme.colors.ready) },
        title = stringResource(R.string.update_title),
        description = stringResource(R.string.update_description),
        details = {
            DetailsCard {
                Version(label = stringResource(R.string.update_on_mac), version = macVersion ?: stringResource(R.string.update_unknown_version))
                Version(label = stringResource(R.string.update_this_app), version = appVersion)
            }
        },
        actions = {
            PrimaryButton(
                text = macVersion?.let { stringResource(R.string.update_get_version, it) }
                    ?: stringResource(R.string.update_get_latest),
                onClick = onGetRelease,
            )
            Text(
                text = stringResource(R.string.update_opens_release),
                modifier = Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.bodySmall,
                color = SwitchboardTheme.colors.textMuted,
                textAlign = TextAlign.Center,
            )
        },
    )
}

@Composable
private fun Version(label: String, version: String) {
    Row {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            color = SwitchboardTheme.colors.textMuted,
        )
        Text(
            text = version,
            style = MaterialTheme.typography.titleSmall,
            color = SwitchboardTheme.colors.textStrong,
        )
    }
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun UpdateRequiredScreenPreview() {
    SwitchboardTheme {
        UpdateRequiredScreen(macVersion = "2.9.0", appVersion = "2.8.1", onGetRelease = {})
    }
}

@Preview(name = "Unknown version, dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Unknown version, light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun UpdateRequiredUnknownVersionPreview() {
    SwitchboardTheme {
        UpdateRequiredScreen(macVersion = null, appVersion = "2.8.1", onGetRelease = {})
    }
}
