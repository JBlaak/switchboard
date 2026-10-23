package dev.jblaak.switchboard.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

/** [template] with its `%1$s` filled by [argument], drawn bold in [color]. */
fun emphasised(template: String, argument: String, color: Color): AnnotatedString {
    val before = template.substringBefore("%1\$s")
    val after = template.substringAfter("%1\$s", "")
    return buildAnnotatedString {
        append(before)
        withStyle(SpanStyle(color = color, fontWeight = FontWeight.Bold)) { append(argument) }
        append(after)
    }
}
