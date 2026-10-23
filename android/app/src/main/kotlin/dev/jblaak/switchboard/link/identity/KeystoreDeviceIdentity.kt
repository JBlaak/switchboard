package dev.jblaak.switchboard.link.identity

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import java.math.BigInteger
import java.security.InvalidAlgorithmParameterException
import java.security.InvalidKeyException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.security.auth.x500.X500Principal

/**
 * The [DeviceIdentity] in Android Keystore: an EC P-256 signing key that never leaves secure hardware, usable for
 * five minutes after a strong biometric unlock. Keystore issues the self-signed certificate itself.
 */
class KeystoreDeviceIdentity : DeviceIdentity {

    private val keyStore: KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    override fun exists(): Boolean = keyStore.containsAlias(ALIAS)

    override fun create(): KeyCreation {
        delete()
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(
                KeyProperties.DIGEST_NONE,
                KeyProperties.DIGEST_SHA256,
                KeyProperties.DIGEST_SHA384,
                KeyProperties.DIGEST_SHA512,
            )
            .setCertificateSubject(X500Principal("CN=Switchboard phone"))
            .setCertificateSerialNumber(BigInteger.valueOf(System.currentTimeMillis()))
            .setCertificateNotBefore(Date())
            .setCertificateNotAfter(Date(System.currentTimeMillis() + 100L * 365 * 24 * 60 * 60 * 1000))
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(300, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .build()
        return try {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
                initialize(spec)
                generateKeyPair()
            }
            KeyCreation.Created
        } catch (exception: InvalidAlgorithmParameterException) {
            KeyCreation.BiometricsUnavailable
        } catch (exception: IllegalStateException) {
            KeyCreation.BiometricsUnavailable
        }
    }

    override fun delete() {
        if (exists()) keyStore.deleteEntry(ALIAS)
    }

    override fun access(): KeyAccess {
        val entry = keyStore.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry ?: return KeyAccess.Missing
        val key = DeviceKey(
            privateKey = entry.privateKey,
            certificateChain = entry.certificateChain.map { it as X509Certificate },
        )
        return when (signingCheck(key)) {
            SigningCheck.Passed -> KeyAccess.Usable(key)
            SigningCheck.NeedsUnlock -> KeyAccess.Locked
            SigningCheck.Invalidated -> KeyAccess.Missing.also { delete() }
        }
    }

    private fun signingCheck(key: DeviceKey): SigningCheck {
        return try {
            Signature.getInstance("SHA256withECDSA").initSign(key.privateKey)
            SigningCheck.Passed
        } catch (exception: UserNotAuthenticatedException) {
            SigningCheck.NeedsUnlock
        } catch (exception: KeyPermanentlyInvalidatedException) {
            SigningCheck.Invalidated
        } catch (exception: InvalidKeyException) {
            SigningCheck.Invalidated
        }
    }

    private enum class SigningCheck { Passed, NeedsUnlock, Invalidated }

    private companion object {
        const val ALIAS = "switchboard-device"
    }
}
