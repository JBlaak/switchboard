package dev.jblaak.switchboard.pair

import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * The back camera's preview, with every frame read for QR codes by ML Kit's bundled model. [onCodes] gets the raw
 * values of the QR codes in a frame, on the main thread; frames without a code are not reported.
 */
@Composable
fun CameraViewfinder(onCodes: (List<String>) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val latestOnCodes by rememberUpdatedState(onCodes)
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }

    AndroidView(factory = { previewView }, modifier = Modifier.fillMaxSize())

    DisposableEffect(lifecycleOwner) {
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val analysisExecutor = Executors.newSingleThreadExecutor()
        val scanner = BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build(),
        )
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener(
            {
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { analysis ->
                        analysis.setAnalyzer(analysisExecutor) { image ->
                            readCodes(scanner, image) { codes -> mainExecutor.execute { latestOnCodes(codes) } }
                        }
                    }
                bindToBackCamera(providerFuture.get(), lifecycleOwner, preview, analysis)
            },
            mainExecutor,
        )
        onDispose {
            if (providerFuture.isDone) providerFuture.get().unbindAll()
            scanner.close()
            analysisExecutor.shutdown()
        }
    }
}

@androidx.annotation.OptIn(ExperimentalGetImage::class)
private fun readCodes(scanner: BarcodeScanner, image: ImageProxy, onCodes: (List<String>) -> Unit) {
    val mediaImage = image.image
    if (mediaImage == null) {
        image.close()
        return
    }
    scanner.process(InputImage.fromMediaImage(mediaImage, image.imageInfo.rotationDegrees))
        .addOnSuccessListener { barcodes ->
            val codes = barcodes.mapNotNull { it.rawValue }
            if (codes.isNotEmpty()) onCodes(codes)
        }
        .addOnCompleteListener { image.close() }
}

private fun bindToBackCamera(
    provider: ProcessCameraProvider,
    lifecycleOwner: LifecycleOwner,
    preview: Preview,
    analysis: ImageAnalysis,
) {
    provider.unbindAll()
    try {
        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
    } catch (exception: IllegalArgumentException) {
        Log.w("CameraViewfinder", "No back camera to scan with", exception)
    }
}
