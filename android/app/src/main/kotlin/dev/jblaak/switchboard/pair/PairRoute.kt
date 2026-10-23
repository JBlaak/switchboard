package dev.jblaak.switchboard.pair

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.jblaak.switchboard.protocol.PairingInvite

/**
 * The pair screen wired to the camera: asks for the camera permission, reads frames through an [InviteScanner],
 * and hands the first invite to [onInviteFound] with a way to resume scanning should the caller not go on with it.
 */
@Composable
fun PairRoute(onInviteFound: (invite: PairingInvite, resumeScanning: () -> Unit) -> Unit) {
    val context = LocalContext.current
    val activity = LocalActivity.current
    val scanner = remember { InviteScanner() }
    val hint by scanner.hint.collectAsState()
    var cameraAccess by remember { mutableStateOf(cameraAccessOf(context, activity, hasAsked = false)) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        cameraAccess = cameraAccessOf(context, activity, hasAsked = true)
    }

    LaunchedEffect(Unit) {
        if (cameraAccess != CameraAccess.Granted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        if (isCameraGranted(context)) cameraAccess = CameraAccess.Granted
    }

    PairScreen(
        hint = hint,
        cameraAccess = cameraAccess,
        onAllowCamera = {
            when (cameraAccess) {
                CameraAccess.InSettings -> context.startActivity(appSettingsIntent(context))
                CameraAccess.Ask, CameraAccess.Granted -> permissionLauncher.launch(Manifest.permission.CAMERA)
            }
        },
        viewfinder = {
            CameraViewfinder(
                onCodes = { codes ->
                    val outcome = scanner.scanned(codes)
                    if (outcome is ScanOutcome.Found) onInviteFound(outcome.invite, scanner::resume)
                },
            )
        },
    )
}

private fun isCameraGranted(context: Context): Boolean {
    return ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
}

private fun cameraAccessOf(context: Context, activity: Activity?, hasAsked: Boolean): CameraAccess {
    return when {
        isCameraGranted(context) -> CameraAccess.Granted
        !hasAsked -> CameraAccess.Ask
        activity?.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA) == true -> CameraAccess.Ask
        else -> CameraAccess.InSettings
    }
}

private fun appSettingsIntent(context: Context): Intent {
    return Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
}
