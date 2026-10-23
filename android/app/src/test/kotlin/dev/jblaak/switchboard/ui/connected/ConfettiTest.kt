package dev.jblaak.switchboard.ui.connected

import androidx.compose.ui.geometry.Offset
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConfettiTest {

    @Test
    fun `every fifth burst is a bigger one`() {
        /* Given */
        val bursts = 1..10

        /* When */
        val pieces = bursts.map(::confettiPieces)

        /* Then */
        assertEquals(listOf(28, 28, 28, 28, 70, 28, 28, 28, 28, 70), pieces)
    }

    @Test
    fun `a burst throws its pieces mostly upwards from where it starts`() {
        /* Given */
        val confetti = Confetti()

        /* When */
        confetti.burst(Offset(100f, 400f), density = 2f, random = Random(7))

        /* Then */
        assertEquals(28, confetti.pieces.size)
        assertTrue(confetti.pieces.all { it.x == 100f && it.y == 400f })
        assertTrue(confetti.pieces.count { it.vy < 0 } > confetti.pieces.size * 3 / 4)
    }

    @Test
    fun `the pieces are gone once their life is over`() {
        /* Given */
        val confetti = Confetti()
        confetti.burst(Offset.Zero, density = 1f, random = Random(7))

        /* When */
        repeat(50) { confetti.step(0.05f) }

        /* Then */
        assertTrue(confetti.pieces.isEmpty())
    }
}
