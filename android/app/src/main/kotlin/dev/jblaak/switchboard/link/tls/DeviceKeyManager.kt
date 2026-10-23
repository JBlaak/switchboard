package dev.jblaak.switchboard.link.tls

import dev.jblaak.switchboard.link.identity.DeviceKey
import java.net.Socket
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager

/** Presents the device key as the TLS client certificate, whatever issuers the server asks for. */
class DeviceKeyManager(private val key: DeviceKey) : X509ExtendedKeyManager() {

    override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? {
        return aliasFor(keyType)
    }

    override fun chooseEngineClientAlias(
        keyType: Array<out String>?,
        issuers: Array<out Principal>?,
        engine: SSLEngine?,
    ): String? = aliasFor(keyType)

    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> {
        return listOfNotNull(aliasFor(arrayOf(keyType.orEmpty()))).toTypedArray()
    }

    override fun getCertificateChain(alias: String?): Array<X509Certificate>? {
        return if (alias == ALIAS) key.certificateChain.toTypedArray() else null
    }

    override fun getPrivateKey(alias: String?): PrivateKey? = if (alias == ALIAS) key.privateKey else null

    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null

    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> = emptyArray()

    private fun aliasFor(keyTypes: Array<out String>?): String? {
        val algorithm = key.privateKey.algorithm
        val matches = keyTypes.orEmpty().any { it.equals(algorithm, ignoreCase = true) || it.startsWith("EC") }
        return if (matches) ALIAS else null
    }

    private companion object {
        const val ALIAS = "device"
    }
}
