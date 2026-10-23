package dev.jblaak.switchboard.theme

import androidx.annotation.FontRes
import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R

/** Headings, labels and controls. */
val MulishFamily = FontFamily(
    variableFont(R.font.mulish, FontWeight.Normal),
    variableFont(R.font.mulish, FontWeight.SemiBold),
    variableFont(R.font.mulish, FontWeight.Bold),
    variableFont(R.font.mulish, FontWeight.ExtraBold),
)

/** Reading text. */
val NunitoSansFamily = FontFamily(
    variableFont(R.font.nunito_sans, FontWeight.Normal),
    variableFont(R.font.nunito_sans, FontWeight.SemiBold),
    variableFont(R.font.nunito_sans, FontWeight.Bold),
)

/** The terminal. */
val JetBrainsMonoFamily = FontFamily(
    variableFont(R.font.jetbrains_mono, FontWeight.Normal),
    variableFont(R.font.jetbrains_mono, FontWeight.SemiBold),
)

private fun variableFont(@FontRes resource: Int, weight: FontWeight): Font {
    return Font(
        resId = resource,
        weight = weight,
        variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
    )
}

private fun heading(weight: FontWeight, size: Int, lineHeight: Int, letterSpacing: Double): TextStyle {
    return TextStyle(
        fontFamily = MulishFamily,
        fontWeight = weight,
        fontSize = size.sp,
        lineHeight = lineHeight.sp,
        letterSpacing = letterSpacing.sp,
    )
}

private fun reading(size: Int, lineHeight: Int): TextStyle {
    return TextStyle(
        fontFamily = NunitoSansFamily,
        fontWeight = FontWeight.Normal,
        fontSize = size.sp,
        lineHeight = lineHeight.sp,
    )
}

internal val SwitchboardTypography = Typography(
    displayLarge = heading(FontWeight.ExtraBold, 48, 56, -0.5),
    displayMedium = heading(FontWeight.ExtraBold, 40, 48, -0.5),
    displaySmall = heading(FontWeight.ExtraBold, 32, 40, -0.4),
    headlineLarge = heading(FontWeight.ExtraBold, 30, 38, -0.3),
    headlineMedium = heading(FontWeight.ExtraBold, 26, 32, -0.3),
    headlineSmall = heading(FontWeight.ExtraBold, 22, 28, -0.2),
    titleLarge = heading(FontWeight.Bold, 20, 26, 0.0),
    titleMedium = heading(FontWeight.Bold, 16, 22, 0.0),
    titleSmall = heading(FontWeight.Bold, 15, 20, 0.0),
    bodyLarge = reading(16, 24),
    bodyMedium = reading(14, 20),
    bodySmall = reading(13, 18),
    labelLarge = heading(FontWeight.ExtraBold, 15, 20, 0.0),
    labelMedium = heading(FontWeight.Bold, 13, 18, 0.0),
    labelSmall = heading(FontWeight.ExtraBold, 12, 16, 0.8),
)

/** The terminal's text: JetBrains Mono at the size the design draws it. */
val TerminalTextStyle = TextStyle(
    fontFamily = JetBrainsMonoFamily,
    fontWeight = FontWeight.Normal,
    fontSize = 11.sp,
    lineHeight = 16.sp,
)
