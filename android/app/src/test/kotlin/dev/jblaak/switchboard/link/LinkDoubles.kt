package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.discovery.MacDiscovery
import dev.jblaak.switchboard.link.identity.DeviceIdentity
import dev.jblaak.switchboard.link.identity.DeviceKey
import dev.jblaak.switchboard.link.identity.KeyAccess
import dev.jblaak.switchboard.link.identity.KeyCreation
import dev.jblaak.switchboard.link.pairing.PairingStore
import dev.jblaak.switchboard.link.pairing.StoredPairing
import dev.jblaak.switchboard.link.transport.LinkConnection
import dev.jblaak.switchboard.link.transport.LinkTransport
import dev.jblaak.switchboard.link.transport.TransportEvent
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.ProtocolCodec
import kotlinx.coroutines.channels.Channel
import okhttp3.tls.HeldCertificate

/** A software key in place of Android Keystore, with a switch for the five-minute unlock window. */
internal class SoftwareDeviceIdentity : DeviceIdentity {

    var held: HeldCertificate? = null
    var locked = false
    var biometricsEnrolled = true
    var created = 0

    override fun exists(): Boolean = held != null

    override fun create(): KeyCreation {
        if (!biometricsEnrolled) return KeyCreation.BiometricsUnavailable
        created++
        held = newDeviceCertificate()
        return KeyCreation.Created
    }

    override fun delete() {
        held = null
    }

    override fun access(): KeyAccess {
        val certificate = held ?: return KeyAccess.Missing
        if (locked) return KeyAccess.Locked
        return KeyAccess.Usable(DeviceKey(certificate.keyPair.private, listOf(certificate.certificate)))
    }
}

internal fun newDeviceCertificate(): HeldCertificate {
    return HeldCertificate.Builder().commonName("Switchboard phone").ecdsa256().build()
}

internal class InMemoryPairingStore(var pairing: StoredPairing?) : PairingStore {

    override fun loadOrNull(): StoredPairing? = pairing

    override fun save(pairing: StoredPairing) {
        this.pairing = pairing
    }

    override fun clear() {
        pairing = null
    }
}

internal class FakeDiscovery(var found: List<MacAddress>) : MacDiscovery {

    var lookups = 0

    override suspend fun discover(): List<MacAddress> {
        lookups++
        return found
    }
}

/**
 * Hands out [FakeConnection]s whose first event [firstEvent] decides (opened, or a failure); the test plays the
 * Mac from there on the connection's [FakeConnection.mac] side.
 */
internal class FakeTransport(var firstEvent: (MacAddress) -> TransportEvent) : LinkTransport {

    val connections = mutableListOf<FakeConnection>()

    val last: FakeConnection get() = connections.last()

    override fun open(address: MacAddress, key: DeviceKey, macFingerprint: String): LinkConnection {
        val connection = FakeConnection(address, macFingerprint)
        connection.mac(firstEvent(address))
        connections += connection
        return connection
    }
}

internal class FakeConnection(val address: MacAddress, val macFingerprint: String) : LinkConnection {

    override val events = Channel<TransportEvent>(Channel.UNLIMITED)

    val sentText = mutableListOf<String>()
    var closedByPhone = false

    val sent: List<ClientMessage>
        get() = sentText.map { ProtocolCodec().json.decodeFromString(ClientMessage.serializer(), it) }

    fun mac(event: TransportEvent) {
        events.trySend(event)
    }

    fun macSays(json: String) = mac(TransportEvent.Text(json))

    fun macCloses(code: Int) = mac(TransportEvent.Closed(code, ""))

    override fun send(text: String): Boolean {
        if (closedByPhone) return false
        sentText += text
        return true
    }

    override fun close(code: Int, reason: String) {
        closedByPhone = true
    }
}

internal const val MAC_FINGERPRINT = "aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11"

internal val lastAddress = MacAddress("192.168.1.20", 52840)

internal fun storedPairing() = StoredPairing(
    macFingerprint = MAC_FINGERPRINT,
    deviceId = "d-7",
    macName = "Studio",
    lastAddress = lastAddress,
)

internal const val WELCOME = """{"type":"welcome","protocol":1,"macName":"Studio","deviceId":"d-7"}"""
