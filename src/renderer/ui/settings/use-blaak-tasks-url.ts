/**
 * The BlaakTasks URL field's check (#252): does a server in `~/.claude.json`
 * have this URL? Main answers yes or no; the token never comes here.
 *
 * Checked for the stored URL when the form opens, then each time the field
 * is committed (blur or Enter, the input's native `change`), so a URL half
 * typed doesn't flash the "add it" line. An answer for a URL since typed over
 * is dropped.
 */
import { useEffect, useRef, useState } from 'react';
import { blaakTasksSetUp } from './actions';
import type { RefObject } from 'react';

export interface BlaakTasksUrlField {
  urlRef: RefObject<HTMLInputElement | null>;
  /** The URL the answer is for, trimmed. */
  checked: string;
  /** Whether a server has `checked`; null until main has answered. */
  setUp: boolean | null;
}

export function useBlaakTasksUrl(initial: string): BlaakTasksUrlField {
  const urlRef = useRef<HTMLInputElement | null>(null);
  const [answer, setAnswer] = useState<{ checked: string; setUp: boolean | null }>({ checked: initial.trim(), setUp: null });

  useEffect(() => {
    const check = (url: string): void => {
      const trimmed = url.trim();
      setAnswer({ checked: trimmed, setUp: null });
      if (!trimmed) return;
      void blaakTasksSetUp(trimmed).then((setUp) => {
        if ((urlRef.current?.value ?? trimmed).trim() !== trimmed) return; // typed over meanwhile
        setAnswer({ checked: trimmed, setUp });
      });
    };
    check(initial);
    const input = urlRef.current;
    if (!input) return;
    const onChange = (): void => check(input.value);
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  }, []);

  return { urlRef, ...answer };
}
