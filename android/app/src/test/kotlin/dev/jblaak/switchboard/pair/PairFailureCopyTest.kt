package dev.jblaak.switchboard.pair

import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.link.PairFailure
import dev.jblaak.switchboard.protocol.PROTOCOL_VERSION
import dev.jblaak.switchboard.protocol.PairRejection
import org.junit.Assert.assertEquals
import org.junit.Test

class PairFailureCopyTest {

    @Test
    fun `an expired code says it expired`() {
        /* Given */
        val failure = PairFailure.Rejected(PairRejection.Expired)

        /* When */
        val copy = pairFailureCopyOf(failure)

        /* Then */
        assertEquals(R.string.pair_failed_expired_title, copy.title)
    }

    @Test
    fun `a protocol mismatch names both protocols`() {
        /* Given */
        val failure = PairFailure.ProtocolMismatch(macProtocol = 7)

        /* When */
        val copy = pairFailureCopyOf(failure)

        /* Then */
        assertEquals(listOf<Any>(7, PROTOCOL_VERSION), copy.descriptionArguments)
    }

    @Test
    fun `the Mac no longer pairing reads the same whichever way it was said`() {
        /* Given */
        val rejected = PairFailure.Rejected(PairRejection.NotPairing)

        /* When */
        val copy = pairFailureCopyOf(rejected)

        /* Then */
        assertEquals(pairFailureCopyOf(PairFailure.NotPairing), copy)
    }
}
