package dev.jblaak.switchboard.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.style.TextDecoration
import dev.jblaak.switchboard.theme.SwitchboardTheme

private val webLink = Regex("""https?://[^\s<>"'`]+""", RegexOption.IGNORE_CASE)
private const val TRAILING_PUNCTUATION = ".,;:!?'\"*_"

/**
 * Where the http and https links are in [text], as a chat message types them: the punctuation that ends the
 * sentence around a link is left out, and so is a closing bracket the link didn't open.
 */
fun webLinksIn(text: String): List<IntRange> = webLink.findAll(text).mapNotNull { match ->
    var end = match.range.last
    while (end > match.range.first) {
        val last = text[end]
        val unopened = last in ")]}" && text.substring(match.range.first, end + 1).let { it.count(opening(last)::equals) < it.count(last::equals) }
        if (last in TRAILING_PUNCTUATION || unopened) end-- else break
    }
    (match.range.first..end).takeIf { text.substring(it).substringAfter("://").isNotEmpty() }
}.toList()

private fun opening(closing: Char) = when (closing) {
    ')' -> '('
    ']' -> '['
    else -> '{'
}

/** [text] with its web links as tappable [LinkAnnotation.Url]s, which open in the phone's browser. */
fun linkified(text: String, styles: TextLinkStyles? = null): AnnotatedString = AnnotatedString.Builder(text).apply {
    for (range in webLinksIn(text)) {
        addLink(LinkAnnotation.Url(text.substring(range), styles), range.first, range.last + 1)
    }
}.toAnnotatedString()

/** [linkified] in the house link style: the accent colour, underlined. */
@Composable
fun rememberLinkified(text: String): AnnotatedString {
    val accent: Color = SwitchboardTheme.colors.accent
    return remember(text, accent) {
        linkified(text, TextLinkStyles(style = SpanStyle(color = accent, textDecoration = TextDecoration.Underline)))
    }
}
