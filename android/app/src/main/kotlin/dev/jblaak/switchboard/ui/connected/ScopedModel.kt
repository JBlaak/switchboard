package dev.jblaak.switchboard.ui.connected

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

/**
 * A state holder that lives as long as this spot in the composition (and [key]), on a scope of its own that is
 * cancelled when it leaves; [onLeave] runs first, for anything the holder has to say on its way out.
 */
@Composable
fun <T : Any> rememberScopedModel(key: Any, onLeave: (T) -> Unit = {}, create: (CoroutineScope) -> T): T {
    val scope = remember(key) { CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate) }
    val model = remember(key) { create(scope) }
    DisposableEffect(key) {
        onDispose {
            onLeave(model)
            scope.cancel()
        }
    }
    return model
}
