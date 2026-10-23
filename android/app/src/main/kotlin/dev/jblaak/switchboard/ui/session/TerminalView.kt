package dev.jblaak.switchboard.ui.session

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import kotlinx.coroutines.flow.Flow

/** The house terminal background, the same in light and dark: the terminal always uses the dark palette. */
val TerminalBackground = Color(0xFF141517)

/**
 * A session's terminal: xterm.js from the APK's assets in a WebView that loads nothing else. [writes] are fed to
 * it a frame at a time; [onOpened] comes each time the page has loaded and fitted itself (an empty terminal to
 * replay into), [onResized] whenever the fit changes. The terminal takes no typing of its own.
 */
@Composable
fun TerminalView(
    writes: Flow<TerminalWrite>,
    onOpened: (TerminalSize) -> Unit,
    onResized: (TerminalSize) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (LocalInspectionMode.current) {
        Box(modifier.background(TerminalBackground))
        return
    }
    val opened = rememberUpdatedState(onOpened)
    val resized = rememberUpdatedState(onResized)
    val bridge = remember {
        TerminalBridge { event ->
            when (event) {
                is TerminalEvent.Ready -> opened.value(event.size)
                is TerminalEvent.Resized -> resized.value(event.size)
            }
        }
    }
    LaunchedEffect(writes) {
        writes.collect { bridge.enqueue(it) }
    }
    DisposableEffect(bridge) {
        onDispose { bridge.destroy() }
    }
    AndroidView(
        factory = { context -> bridge.createWebView(context) },
        modifier = modifier.background(TerminalBackground),
    )
}

/** Holds the WebView, queues writes until the page is ready, and flushes them once per display frame. */
private class TerminalBridge(private val onEvent: (TerminalEvent) -> Unit) {

    private val pending = mutableListOf<TerminalWrite>()
    private var webView: WebView? = null
    private var ready = false
    private var flushScheduled = false
    private val flush = Choreographer.FrameCallback {
        flushScheduled = false
        flushNow()
    }

    fun enqueue(write: TerminalWrite) {
        pending += write
        scheduleFlush()
    }

    fun destroy() {
        Choreographer.getInstance().removeFrameCallback(flush)
        webView?.destroy()
        webView = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun createWebView(context: Context): WebView {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .addPathHandler("/res/", WebViewAssetLoader.ResourcesPathHandler(context))
            .build()
        return WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setBackgroundColor(android.graphics.Color.rgb(0x14, 0x15, 0x17))
            isFocusable = false
            isFocusableInTouchMode = false
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            settings.setSupportZoom(false)
            webViewClient = AssetsOnlyClient(loader)
            listen(this)
            loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/terminal/index.html")
            webView = this
        }
    }

    @SuppressLint("AddJavascriptInterface")
    private fun listen(view: WebView) {
        val main = Handler(Looper.getMainLooper())
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(
                view,
                "switchboard",
                setOf("https://${WebViewAssetLoader.DEFAULT_DOMAIN}"),
            ) { _, message, _, _, _ ->
                message.data?.let { received(it) }
            }
        } else {
            view.addJavascriptInterface(
                object {
                    @JavascriptInterface
                    fun postMessage(message: String) {
                        main.post { received(message) }
                    }
                },
                "switchboard",
            )
        }
    }

    private fun received(message: String) {
        val event = terminalEventOrNull(message) ?: return
        if (event is TerminalEvent.Ready) {
            ready = true
            pending.clear()
        }
        onEvent(event)
        scheduleFlush()
    }

    private fun scheduleFlush() {
        if (flushScheduled || !ready || pending.isEmpty()) return
        flushScheduled = true
        Choreographer.getInstance().postFrameCallback(flush)
    }

    private fun flushNow() {
        val view = webView ?: return
        if (!ready || pending.isEmpty()) return
        val script = terminalScriptOf(pending.toList())
        pending.clear()
        view.evaluateJavascript(script, null)
    }
}

/** Serves the bundled assets and refuses everything else, so the page can never reach the network. */
private class AssetsOnlyClient(private val loader: WebViewAssetLoader) : WebViewClient() {

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
        return loader.shouldInterceptRequest(request.url) ?: refused()
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

    private fun refused(): WebResourceResponse {
        return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
