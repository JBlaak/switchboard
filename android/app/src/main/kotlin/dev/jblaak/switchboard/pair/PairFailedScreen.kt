package dev.jblaak.switchboard.pair

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.MessageScreen
import dev.jblaak.switchboard.components.PrimaryButton
import dev.jblaak.switchboard.components.StatusBadge
import dev.jblaak.switchboard.link.PairFailure
import dev.jblaak.switchboard.protocol.PROTOCOL_VERSION
import dev.jblaak.switchboard.protocol.PairRejection
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** Pairing did not finish: why, in words, and Try again back to the camera. */
@Composable
fun PairFailedScreen(failure: PairFailure, onTryAgain: () -> Unit) {
    val copy = pairFailureCopyOf(failure)
    MessageScreen(
        badge = { StatusBadge(icon = R.drawable.ic_alert, colors = SwitchboardTheme.colors.needsYou) },
        title = stringResource(copy.title),
        description = stringResource(copy.description, *copy.descriptionArguments.toTypedArray()),
        details = null,
        actions = {
            PrimaryButton(text = stringResource(R.string.try_again), onClick = onTryAgain)
        },
    )
}

internal data class PairFailureCopy(
    @param:StringRes val title: Int,
    @param:StringRes val description: Int,
    val descriptionArguments: List<Any>,
)

internal fun pairFailureCopyOf(failure: PairFailure): PairFailureCopy {
    return when (failure) {
        is PairFailure.Rejected -> rejectionCopyOf(failure.reason)
        is PairFailure.ProtocolMismatch -> PairFailureCopy(
            title = R.string.pair_failed_protocol_title,
            description = R.string.pair_failed_protocol_description,
            descriptionArguments = listOf(failure.macProtocol, PROTOCOL_VERSION),
        )
        PairFailure.BiometricsUnavailable -> copy(R.string.pair_failed_biometrics_title, R.string.pair_failed_biometrics_description)
        PairFailure.WrongMac -> copy(R.string.pair_failed_wrong_mac_title, R.string.pair_failed_wrong_mac_description)
        PairFailure.NotPairing -> copy(R.string.pair_failed_not_pairing_title, R.string.pair_failed_not_pairing_description)
        PairFailure.NotFound -> copy(R.string.pair_failed_not_found_title, R.string.pair_failed_not_found_description)
        PairFailure.Interrupted -> copy(R.string.pair_failed_interrupted_title, R.string.pair_failed_interrupted_description)
    }
}

private fun rejectionCopyOf(reason: PairRejection): PairFailureCopy {
    return when (reason) {
        PairRejection.Expired -> copy(R.string.pair_failed_expired_title, R.string.pair_failed_expired_description)
        PairRejection.WrongCode -> copy(R.string.pair_failed_wrong_code_title, R.string.pair_failed_wrong_code_description)
        PairRejection.LockedOut -> copy(R.string.pair_failed_locked_out_title, R.string.pair_failed_locked_out_description)
        PairRejection.Declined -> copy(R.string.pair_failed_declined_title, R.string.pair_failed_declined_description)
        PairRejection.NotPairing -> copy(R.string.pair_failed_not_pairing_title, R.string.pair_failed_not_pairing_description)
    }
}

private fun copy(@StringRes title: Int, @StringRes description: Int): PairFailureCopy {
    return PairFailureCopy(title = title, description = description, descriptionArguments = emptyList())
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun PairFailedScreenPreview() {
    SwitchboardTheme {
        PairFailedScreen(failure = PairFailure.Rejected(PairRejection.Expired), onTryAgain = {})
    }
}

@Preview(name = "Protocol, dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Protocol, light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun PairFailedProtocolPreview() {
    SwitchboardTheme {
        PairFailedScreen(failure = PairFailure.ProtocolMismatch(macProtocol = 2), onTryAgain = {})
    }
}
