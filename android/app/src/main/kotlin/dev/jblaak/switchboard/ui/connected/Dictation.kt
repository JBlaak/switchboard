package dev.jblaak.switchboard.ui.connected

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState

/** Starts the system's speech recogniser and hands what it heard to [onHeard]. */
@Composable
fun rememberDictation(onHeard: (String) -> Unit): () -> Unit {
    val heard = rememberUpdatedState(onHeard)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val text = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!text.isNullOrBlank()) heard.value(text)
    }
    return remember(launcher) {
        {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            try {
                launcher.launch(intent)
            } catch (exception: ActivityNotFoundException) {
                Log.w("Dictation", "No speech recogniser on this phone", exception)
            }
        }
    }
}

/** Dictated [heard] added to [text], with a space between. */
fun withDictated(text: String, heard: String): String {
    if (text.isBlank()) return heard
    return if (text.endsWith(' ') || text.endsWith('\n')) text + heard else "$text $heard"
}
