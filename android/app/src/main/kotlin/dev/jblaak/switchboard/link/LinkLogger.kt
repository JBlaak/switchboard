package dev.jblaak.switchboard.link

/**
 * Where the link writes what it does: state changes, dial attempts and their failures, Bonjour lookups, nudges and
 * network changes. The app writes to logcat under one tag (see `createMacLink`); tests stay [Silent] or record.
 *
 * Never hand it key material, and only the start of a fingerprint (see [shortFingerprint]).
 */
interface LinkLogger {

    fun info(message: String)

    fun warn(message: String)

    /** Drops every line: the default outside the app. */
    data object Silent : LinkLogger {
        override fun info(message: String) = Unit

        override fun warn(message: String) = Unit
    }
}

/** The first eight hex characters of a certificate fingerprint: enough to tell Macs apart in a log, no more. */
fun shortFingerprint(fingerprint: String): String = fingerprint.take(8) + "…"
