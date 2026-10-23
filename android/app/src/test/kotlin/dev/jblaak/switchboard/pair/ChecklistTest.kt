package dev.jblaak.switchboard.pair

import dev.jblaak.switchboard.shell.PairingStep
import org.junit.Assert.assertEquals
import org.junit.Test

class ChecklistTest {

    @Test
    fun `while finding the Mac only the first line is under way`() {
        /* Given */
        val step = PairingStep.Finding

        /* When */
        val statuses = checklistOf(step).map { it.status }

        /* Then */
        assertEquals(listOf(CheckStatus.Working, CheckStatus.Pending, CheckStatus.Pending, CheckStatus.Pending), statuses)
    }

    @Test
    fun `while the code is checked the first three lines are done`() {
        /* Given */
        val step = PairingStep.CheckingCode

        /* When */
        val checklist = checklistOf(step)

        /* Then */
        assertEquals(
            listOf(
                ChecklistItem(ChecklistEntry.FoundMac, CheckStatus.Done),
                ChecklistItem(ChecklistEntry.FingerprintMatches, CheckStatus.Done),
                ChecklistItem(ChecklistEntry.KeyMade, CheckStatus.Done),
                ChecklistItem(ChecklistEntry.CodeChecked, CheckStatus.Working),
            ),
            checklist,
        )
    }

    @Test
    fun `while the Mac asks its user the last line waits on it`() {
        /* Given */
        val step = PairingStep.WaitingOnMac

        /* When */
        val last = checklistOf(step).last()

        /* Then */
        assertEquals(ChecklistItem(ChecklistEntry.ConfirmedOnMac, CheckStatus.Working), last)
    }
}
