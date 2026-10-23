package dev.jblaak.switchboard.link.tls

import java.security.MessageDigest
import java.security.cert.X509Certificate

/** Lowercase hex SHA-256 of the certificate's DER, without separators: how both sides name a certificate. */
fun X509Certificate.sha256Fingerprint(): String {
    return MessageDigest.getInstance("SHA-256").digest(encoded).joinToString("") { "%02x".format(it) }
}
