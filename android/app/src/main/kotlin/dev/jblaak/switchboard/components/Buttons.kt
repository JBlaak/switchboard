package dev.jblaak.switchboard.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** The mint, full-width call to action. */
@Composable
fun PrimaryButton(text: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp),
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = SwitchboardTheme.colors.accent,
            contentColor = SwitchboardTheme.colors.onAccent,
        ),
    ) {
        Text(text = text, style = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp))
    }
}

/** The ringed button for backing out, like Cancel. */
@Composable
fun OutlineButton(text: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp),
        shape = CircleShape,
        border = BorderStroke(1.dp, SwitchboardTheme.colors.borderStrong),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = SwitchboardTheme.colors.textStrong),
    ) {
        Text(text = text, style = MaterialTheme.typography.titleSmall)
    }
}

/** The plain-text second choice under a [PrimaryButton]. */
@Composable
fun QuietButton(text: String, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp),
        shape = CircleShape,
        colors = ButtonDefaults.textButtonColors(contentColor = SwitchboardTheme.colors.textDim),
    ) {
        Text(text = text, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold))
    }
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun ButtonsPreview() {
    SwitchboardTheme {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            PrimaryButton(text = "Pair again", onClick = {})
            OutlineButton(text = "Cancel", onClick = {})
            QuietButton(text = "Forget this Mac", onClick = {})
        }
    }
}
