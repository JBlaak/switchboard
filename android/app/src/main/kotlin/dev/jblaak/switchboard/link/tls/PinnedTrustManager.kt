package dev.jblaak.switchboard.link.tls

import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.X509TrustManager

/**
 * Trusts exactly one server certificate, the one whose fingerprint the pairing QR code carried, and nothing else:
 * no CA, no chain, no host name. Its [verdict] tells a refusal by the pinned Mac apart from a wrong server or no
 * server at all, which the TLS exception itself does not say reliably across providers.
 */
class PinnedTrustManager(private val pinnedFingerprint: String) : X509TrustManager {

    @Volatile
    var verdict: PinVerdict = PinVerdict.NotChecked
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val matches = chain?.firstOrNull()?.sha256Fingerprint() == pinnedFingerprint
        verdict = if (matches) PinVerdict.Matched else PinVerdict.Mismatched
        if (!matches) throw CertificateException("The server's certificate is not the pinned one")
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("This trust manager only checks servers")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

enum class PinVerdict { NotChecked, Matched, Mismatched }
