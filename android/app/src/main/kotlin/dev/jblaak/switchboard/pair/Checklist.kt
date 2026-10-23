package dev.jblaak.switchboard.pair

import dev.jblaak.switchboard.shell.PairingStep

/** One line of the pairing checklist. */
internal data class ChecklistItem(val entry: ChecklistEntry, val status: CheckStatus)

internal enum class ChecklistEntry {
    FoundMac,
    FingerprintMatches,
    KeyMade,
    CodeChecked,
    ConfirmedOnMac,
}

internal enum class CheckStatus {
    Done,
    Working,
    Pending,
}

/** The checklist's four lines for how far pairing got: the last line says what the Mac is doing now. */
internal fun checklistOf(step: PairingStep): List<ChecklistItem> {
    return when (step) {
        PairingStep.Finding -> listOf(
            ChecklistItem(ChecklistEntry.FoundMac, CheckStatus.Working),
            ChecklistItem(ChecklistEntry.FingerprintMatches, CheckStatus.Pending),
            ChecklistItem(ChecklistEntry.KeyMade, CheckStatus.Pending),
            ChecklistItem(ChecklistEntry.ConfirmedOnMac, CheckStatus.Pending),
        )
        PairingStep.CheckingCode -> foundAnd(ChecklistItem(ChecklistEntry.CodeChecked, CheckStatus.Working))
        PairingStep.WaitingOnMac -> foundAnd(ChecklistItem(ChecklistEntry.ConfirmedOnMac, CheckStatus.Working))
    }
}

private fun foundAnd(last: ChecklistItem): List<ChecklistItem> {
    return listOf(
        ChecklistItem(ChecklistEntry.FoundMac, CheckStatus.Done),
        ChecklistItem(ChecklistEntry.FingerprintMatches, CheckStatus.Done),
        ChecklistItem(ChecklistEntry.KeyMade, CheckStatus.Done),
        last,
    )
}
