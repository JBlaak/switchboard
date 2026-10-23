package dev.jblaak.switchboard.pair

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.PrimaryButton
import dev.jblaak.switchboard.components.emphasised
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** Whether the camera may run, and if not, what the button under the explanation does. */
enum class CameraAccess {
    Granted,

    /** Not asked yet, or asked and turned down once: the system dialog can still ask. */
    Ask,

    /** Turned down for good: only the app's settings can grant it. */
    InSettings,
}

/** "Pair with your Mac": the camera [viewfinder] with its frame, and a [hint] under it. */
@Composable
fun PairScreen(
    hint: ScanHint,
    cameraAccess: CameraAccess,
    onAllowCamera: () -> Unit,
    viewfinder: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SwitchboardTheme.colors.bgBase)
            .safeDrawingPadding(),
    ) {
        Header()
        Box(
            modifier = Modifier
                .padding(horizontal = 24.dp)
                .fillMaxWidth()
                .height(342.dp)
                .clip(MaterialTheme.shapes.extraLarge)
                .background(Color(0xFF08090A)),
            contentAlignment = Alignment.Center,
        ) {
            SwitchboardTheme(darkTheme = true) {
                when (cameraAccess) {
                    CameraAccess.Granted -> {
                        viewfinder()
                        ScanFrame()
                    }
                    CameraAccess.Ask, CameraAccess.InSettings -> CameraNeeded(cameraAccess, onAllowCamera)
                }
            }
        }
        Spacer(modifier = Modifier.weight(1f))
        PrivacyNote()
        Hint(hint)
    }
}

@Composable
private fun Header() {
    Column(
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 32.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = stringResource(R.string.pair_title),
            style = MaterialTheme.typography.headlineMedium,
            color = SwitchboardTheme.colors.textStrong,
        )
        Text(
            text = emphasised(
                template = stringResource(R.string.pair_description),
                argument = stringResource(R.string.pair_a_phone),
                color = SwitchboardTheme.colors.textStrong,
            ),
            style = MaterialTheme.typography.bodyLarge,
            color = SwitchboardTheme.colors.textMuted,
        )
    }
}

@Composable
private fun ScanFrame() {
    val accent = SwitchboardTheme.colors.accent
    Canvas(modifier = Modifier.size(220.dp)) {
        val corner = 44.dp.toPx()
        val stroke = 4.dp.toPx()
        val radius = CornerRadius(14.dp.toPx())
        val inset = stroke / 2
        val corners = listOf(
            Offset(0f, 0f),
            Offset(size.width - corner, 0f),
            Offset(0f, size.height - corner),
            Offset(size.width - corner, size.height - corner),
        )
        corners.forEach { origin ->
            clipRect(left = origin.x, top = origin.y, right = origin.x + corner, bottom = origin.y + corner) {
                drawRoundRect(
                    color = accent,
                    topLeft = Offset(inset, inset),
                    size = Size(size.width - stroke, size.height - stroke),
                    cornerRadius = radius,
                    style = Stroke(width = stroke),
                )
            }
        }
        drawRoundRect(
            color = accent.copy(alpha = 0.7f),
            topLeft = Offset(20.dp.toPx(), 108.dp.toPx()),
            size = Size(size.width - 40.dp.toPx(), 2.dp.toPx()),
            cornerRadius = CornerRadius(1.dp.toPx()),
        )
    }
}

@Composable
private fun CameraNeeded(cameraAccess: CameraAccess, onAllowCamera: () -> Unit) {
    Column(
        modifier = Modifier.padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.camera_needed),
            style = MaterialTheme.typography.bodyLarge,
            color = SwitchboardTheme.colors.textDim,
            textAlign = TextAlign.Center,
        )
        PrimaryButton(
            text = stringResource(if (cameraAccess == CameraAccess.InSettings) R.string.camera_open_settings else R.string.camera_allow),
            onClick = onAllowCamera,
        )
    }
}

@Composable
private fun PrivacyNote() {
    Row(
        modifier = Modifier
            .padding(start = 24.dp, end = 24.dp, bottom = 16.dp)
            .fillMaxWidth()
            .background(SwitchboardTheme.colors.bgPanel, MaterialTheme.shapes.medium)
            .padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            painter = painterResource(R.drawable.ic_shield_check),
            contentDescription = null,
            modifier = Modifier.size(22.dp),
            tint = SwitchboardTheme.colors.accent,
        )
        Text(
            text = stringResource(R.string.pair_privacy),
            style = MaterialTheme.typography.bodyMedium,
            color = SwitchboardTheme.colors.textDim,
        )
    }
}

@Composable
private fun Hint(hint: ScanHint) {
    Text(
        text = stringResource(
            when (hint) {
                ScanHint.HoldSteady -> R.string.pair_hold_steady
                ScanHint.NotSwitchboard -> R.string.pair_not_switchboard
            },
        ),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 24.dp, end = 24.dp, top = 14.dp, bottom = 32.dp),
        style = MaterialTheme.typography.bodyMedium,
        color = when (hint) {
            ScanHint.HoldSteady -> SwitchboardTheme.colors.textMuted
            ScanHint.NotSwitchboard -> SwitchboardTheme.colors.needsYou.ink
        },
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun PreviewViewfinder() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF2A2B2F)),
    )
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun PairScreenPreview() {
    SwitchboardTheme {
        PairScreen(hint = ScanHint.HoldSteady, cameraAccess = CameraAccess.Granted, onAllowCamera = {}, viewfinder = { PreviewViewfinder() })
    }
}

@Preview(name = "Not Switchboard, dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Not Switchboard, light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun PairScreenNotSwitchboardPreview() {
    SwitchboardTheme {
        PairScreen(hint = ScanHint.NotSwitchboard, cameraAccess = CameraAccess.Granted, onAllowCamera = {}, viewfinder = { PreviewViewfinder() })
    }
}

@Preview(name = "No camera, dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "No camera, light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun PairScreenNoCameraPreview() {
    SwitchboardTheme {
        PairScreen(hint = ScanHint.HoldSteady, cameraAccess = CameraAccess.Ask, onAllowCamera = {}, viewfinder = { PreviewViewfinder() })
    }
}
