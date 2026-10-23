package dev.jblaak.switchboard.lock

import androidx.annotation.StringRes
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import dev.jblaak.switchboard.R

/**
 * A plain strong-biometric prompt, no CryptoObject: a success opens the Keystore key's five-minute window, which
 * is what the link needs.
 */
class BiometricUnlock(private val activity: FragmentActivity) {

    /** False when no strong biometric is enrolled, or the hardware has none. */
    fun canPrompt(): Boolean {
        return BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    }

    fun prompt(@StringRes title: Int, onUnlocked: () -> Unit, onDismissed: () -> Unit) {
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onUnlocked()

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onDismissed()
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(activity.getString(title))
            .setNegativeButtonText(activity.getString(R.string.cancel))
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .build()
        BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback).authenticate(info)
    }
}
