package dev.jblaak.switchboard.components

import androidx.compose.ui.text.LinkAnnotation
import org.junit.Assert.assertEquals
import org.junit.Test

class WebLinksTest {

    private fun linksIn(text: String) = webLinksIn(text).map(text::substring)

    @Test
    fun `http and https links are found in a sentence`() {
        /* Given */
        val text = "See https://github.com/JBlaak/switchboard/pull/326 and http://example.com/a?b=1#c for details"

        /* When */
        val links = linksIn(text)

        /* Then */
        assertEquals(listOf("https://github.com/JBlaak/switchboard/pull/326", "http://example.com/a?b=1#c"), links)
    }

    @Test
    fun `the punctuation that ends the sentence is not part of the link`() {
        /* Given */
        val text = "Merged in https://example.com/pr/1. Also (see https://example.com/docs), \"https://example.com/q\"!"

        /* When */
        val links = linksIn(text)

        /* Then */
        assertEquals(listOf("https://example.com/pr/1", "https://example.com/docs", "https://example.com/q"), links)
    }

    @Test
    fun `brackets the link opened itself stay in it`() {
        /* Given */
        val text = "Read https://en.wikipedia.org/wiki/Switch_(disambiguation) first"

        /* When */
        val links = linksIn(text)

        /* Then */
        assertEquals(listOf("https://en.wikipedia.org/wiki/Switch_(disambiguation)"), links)
    }

    @Test
    fun `text without a web link has none`() {
        /* Given */
        val text = "Open src/main.ts, ftp://host/file or just https:// on its own"

        /* When */
        val links = linksIn(text)

        /* Then */
        assertEquals(emptyList<String>(), links)
    }

    @Test
    fun `each link becomes a tappable url over its own text`() {
        /* Given */
        val text = "PR: https://example.com/pr/1."

        /* When */
        val annotated = linkified(text)

        /* Then */
        val links = annotated.getLinkAnnotations(0, text.length)
        assertEquals(1, links.size)
        assertEquals("https://example.com/pr/1", (links.single().item as LinkAnnotation.Url).url)
        assertEquals(4 to 28, links.single().start to links.single().end)
        assertEquals(text, annotated.text)
    }
}
