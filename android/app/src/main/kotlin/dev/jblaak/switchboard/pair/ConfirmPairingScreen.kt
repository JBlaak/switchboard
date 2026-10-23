package dev.jblaak.switchboard.pair

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.OutlineButton
import dev.jblaak.switchboard.components.emphasised
import dev.jblaak.switchboard.shell.PairingStep
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** "Confirm on your Mac": the checklist of how far pairing with [host] got, and Cancel. */
@Composable
fun ConfirmPairingScreen(host: String, deviceName: String, step: PairingStep, onCancel: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SwitchboardTheme.colors.bgBase)
            .safeDrawingPadding()
            .padding(start = 24.dp, end = 24.dp, bottom = 32.dp),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(32.dp, Alignment.CenterVertically),
        ) {
            PhoneToMac()
            Heading(deviceName = deviceName, step = step)
            Checklist(host = host, step = step)
        }
        OutlineButton(text = stringResource(R.string.cancel), onClick = onCancel)
    }
}

@Composable
private fun PhoneToMac() {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(18.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DeviceTile(icon = R.drawable.ic_phone)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Dot(SwitchboardTheme.colors.accent)
            Dot(SwitchboardTheme.colors.accentDim)
            Dot(SwitchboardTheme.colors.borderStrong)
        }
        DeviceTile(icon = R.drawable.ic_mac)
    }
}

@Composable
private fun DeviceTile(@DrawableRes icon: Int) {
    Box(
        modifier = Modifier
            .size(72.dp)
            .background(SwitchboardTheme.colors.bgPanel, MaterialTheme.shapes.large),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = null,
            modifier = Modifier.size(34.dp),
            tint = SwitchboardTheme.colors.textStrong,
        )
    }
}

@Composable
private fun Dot(color: Color) {
    Box(
        modifier = Modifier
            .size(6.dp)
            .background(color, CircleShape),
    )
}

@Composable
private fun Heading(deviceName: String, step: PairingStep) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            text = stringResource(R.string.confirm_title),
            modifier = Modifier.fillMaxWidth(),
            style = MaterialTheme.typography.headlineMedium,
            color = SwitchboardTheme.colors.textStrong,
            textAlign = TextAlign.Center,
        )
        val description = when (step) {
            PairingStep.WaitingOnMac -> emphasised(
                template = stringResource(R.string.confirm_waiting_description),
                argument = deviceName,
                color = SwitchboardTheme.colors.textStrong,
            )
            PairingStep.Finding, PairingStep.CheckingCode -> AnnotatedString(
                stringResource(R.string.confirm_checking_description),
            )
        }
        Text(
            text = description,
            modifier = Modifier.fillMaxWidth(),
            style = MaterialTheme.typography.bodyLarge,
            color = SwitchboardTheme.colors.textMuted,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun Checklist(host: String, step: PairingStep) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SwitchboardTheme.colors.bgPanel, MaterialTheme.shapes.medium)
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        checklistOf(step).forEach { item ->
            ChecklistRow(text = checklistText(item, host), status = item.status)
        }
    }
}

@Composable
private fun checklistText(item: ChecklistItem, host: String): String {
    return when (item.entry) {
        ChecklistEntry.FoundMac -> when (item.status) {
            CheckStatus.Done -> stringResource(R.string.confirm_found_mac, host)
            CheckStatus.Working, CheckStatus.Pending -> stringResource(R.string.confirm_looking_for_mac, host)
        }
        ChecklistEntry.FingerprintMatches -> stringResource(R.string.confirm_fingerprint_matches)
        ChecklistEntry.KeyMade -> stringResource(R.string.confirm_key_made)
        ChecklistEntry.CodeChecked -> stringResource(R.string.confirm_checking_code)
        ChecklistEntry.ConfirmedOnMac -> stringResource(R.string.confirm_waiting_on_mac)
    }
}

@Composable
private fun ChecklistRow(text: String, status: CheckStatus) {
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
        StatusMark(status)
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            color = when (status) {
                CheckStatus.Done -> SwitchboardTheme.colors.textStrong
                CheckStatus.Working, CheckStatus.Pending -> SwitchboardTheme.colors.textMuted
            },
        )
    }
}

@Composable
private fun StatusMark(status: CheckStatus) {
    when (status) {
        CheckStatus.Done -> Box(
            modifier = Modifier
                .size(24.dp)
                .background(SwitchboardTheme.colors.running.fill, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                painter = painterResource(R.drawable.ic_check),
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = SwitchboardTheme.colors.accent,
            )
        }
        CheckStatus.Working -> CircularProgressIndicator(
            modifier = Modifier.size(24.dp),
            color = SwitchboardTheme.colors.accent,
            trackColor = SwitchboardTheme.colors.borderStrong,
            strokeWidth = 2.5.dp,
        )
        CheckStatus.Pending -> Box(
            modifier = Modifier
                .size(24.dp)
                .border(2.5.dp, SwitchboardTheme.colors.borderStrong, CircleShape),
        )
    }
}

@Preview(name = "Waiting, dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Waiting, light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun ConfirmPairingWaitingPreview() {
    SwitchboardTheme {
        ConfirmPairingScreen(host = "joris-mbp.local", deviceName = "Pixel 9 Pro", step = PairingStep.WaitingOnMac, onCancel = {})
    }
}

@Preview(name = "Finding, dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Finding, light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun ConfirmPairingFindingPreview() {
    SwitchboardTheme {
        ConfirmPairingScreen(host = "joris-mbp.local", deviceName = "Pixel 9 Pro", step = PairingStep.Finding, onCancel = {})
    }
}
