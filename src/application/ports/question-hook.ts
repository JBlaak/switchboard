/**
 * Where a Claude session's question hook posts to.
 *
 * The hook is a URL baked into each launch's `--settings`, so the question
 * service has to know the server's address and secret before the CLI is
 * spawned — but not how the server is built. The address is null until the
 * server is listening (and stays null if it never managed to), in which case a
 * session simply launches without the hook and asks in its own terminal.
 */

export interface QuestionHookEndpoint {
  /** The server's base URL, e.g. `http://127.0.0.1:53124`; null while not listening. */
  readonly url: string | null;
  /** The per-run secret the hook must send in QUESTION_HOOK_TOKEN_HEADER. */
  readonly token: string;
}
