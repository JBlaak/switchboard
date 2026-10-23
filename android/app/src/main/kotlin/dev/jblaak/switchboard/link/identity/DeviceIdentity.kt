package dev.jblaak.switchboard.link.identity

import java.security.PrivateKey
import java.security.cert.X509Certificate

/**
 * The phone's own key pair and the self-signed certificate it presents as its TLS client certificate. The Mac
 * enrols the fingerprint of that certificate at pairing, so this key is the pairing: made by [create] when a
 * pairing starts, removed by [delete] when it is forgotten or revoked.
 */
interface DeviceIdentity {

    fun exists(): Boolean

    /** Replaces any key there was with a new one. */
    fun create(): KeyCreation

    fun delete()

    /** Whether the key can sign right now, which a biometric unlock in the last five minutes decides. */
    fun access(): KeyAccess
}

/** A private key and the certificate chain that goes with it, leaf first. */
class DeviceKey(
    val privateKey: PrivateKey,
    val certificateChain: List<X509Certificate>,
) {
    val certificate: X509Certificate get() = certificateChain.first()
}

sealed interface KeyCreation {

    data object Created : KeyCreation

    /** The phone has no strong biometric enrolled (or no screen lock), which a biometric-bound key needs. */
    data object BiometricsUnavailable : KeyCreation
}

sealed interface KeyAccess {

    data class Usable(val key: DeviceKey) : KeyAccess

    /** The key is there but needs a biometric unlock before it signs again. */
    data object Locked : KeyAccess

    /** There is no key, or the system invalidated it (new biometrics enrolled, screen lock removed). */
    data object Missing : KeyAccess
}
