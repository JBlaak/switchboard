package dev.jblaak.switchboard.protocol

import java.net.URLDecoder

/**
 * What the pairing QR code on the Mac holds, read from
 * `switchboard://pair?v=<protocol>&fp=<fingerprint>&code=<code>&host=<host>&port=<port>`.
 */
data class PairingInvite(
    val protocol: Int,
    /** The Mac's certificate fingerprint: lowercase hex SHA-256 without separators. */
    val fingerprint: String,
    /** The one-time pairing code. */
    val code: String,
    /** The Bonjour host name, e.g. "joris-mbp.local"; a hint, the fingerprint is what counts. */
    val host: String,
    val port: Int,
) {
    companion object {
        private const val PREFIX = "switchboard://pair?"
        private val FINGERPRINT = Regex("[0-9a-f]{64}")

        /** Null for anything that is not a complete, well-formed invite. */
        fun parseOrNull(text: String): PairingInvite? {
            val trimmed = text.trim()
            if (!trimmed.startsWith(PREFIX, ignoreCase = true)) return null
            val parameters = queryParametersOrNull(trimmed.substring(PREFIX.length)) ?: return null
            val fingerprint = parameters["fp"]?.lowercase()?.takeIf { FINGERPRINT.matches(it) } ?: return null
            return PairingInvite(
                protocol = parameters["v"]?.toIntOrNull() ?: return null,
                fingerprint = fingerprint,
                code = parameters["code"]?.takeIf { it.isNotBlank() } ?: return null,
                host = parameters["host"]?.takeIf { it.isNotBlank() } ?: return null,
                port = parameters["port"]?.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null,
            )
        }

        private fun queryParametersOrNull(query: String): Map<String, String>? {
            val pairs = query.split('&').filter { it.isNotEmpty() }.map { parameter ->
                val name = parameter.substringBefore('=')
                val value = decodeOrNull(parameter.substringAfter('=', "")) ?: return null
                name to value
            }
            return pairs.toMap()
        }

        private fun decodeOrNull(value: String): String? {
            return try {
                URLDecoder.decode(value, Charsets.UTF_8)
            } catch (exception: IllegalArgumentException) {
                null
            }
        }
    }
}
