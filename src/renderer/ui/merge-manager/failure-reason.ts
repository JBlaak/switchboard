/**
 * Why a Merge manager call failed, from whichever shape its answer took.
 *
 * Main's own refusals say `reason`; a call that threw (the VM that merges
 * could not be reached, say) comes back as the IPC wrapper's `{ok: false,
 * error}` envelope instead. Either way the toast says what went wrong.
 */
export function failureReason(answer: unknown, fallback: string): string {
    if (answer && typeof answer === 'object') {
        const {reason, error} = answer as {reason?: unknown; error?: unknown};
        if (typeof reason === 'string' && reason) return reason;
        if (typeof error === 'string' && error) return error;
    }
    return fallback;
}
