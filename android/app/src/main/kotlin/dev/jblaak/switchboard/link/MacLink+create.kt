package dev.jblaak.switchboard.link

import android.content.Context
import android.net.nsd.NsdManager
import android.os.Build
import dev.jblaak.switchboard.link.discovery.NsdMacDiscovery
import dev.jblaak.switchboard.link.identity.KeystoreDeviceIdentity
import dev.jblaak.switchboard.link.pairing.SharedPreferencesPairingStore
import dev.jblaak.switchboard.link.transport.OkHttpLinkTransport
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope

/** The app's [MacLink], wired to Android Keystore, NSD, the app's preferences and OkHttp. Make one per process. */
fun createMacLink(context: Context, scope: CoroutineScope): MacLink {
    return MacLink(
        identity = KeystoreDeviceIdentity(),
        pairingStore = SharedPreferencesPairingStore(context.getSharedPreferences("pairing", Context.MODE_PRIVATE)),
        discovery = NsdMacDiscovery(context.getSystemService(NsdManager::class.java)),
        transport = OkHttpLinkTransport(OkHttpLinkTransport.baseClient()),
        backoff = ReconnectBackoff(first = 1.seconds, cap = 10.seconds, attempts = 8),
        deviceName = Build.MODEL,
        appVersion = context.packageManager.getPackageInfo(context.packageName, 0).versionName.orEmpty(),
        scope = scope,
    )
}
