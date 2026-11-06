/**
 * The 1Password heads-up pop-up's answers: Enter or Escape, under the
 * heads-up's id, into OnePasswordHeadsUpService.
 */
import {SEND} from '../../ipc/channels';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

export function registerHeadsUpHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.on(SEND.headsUpAnswer, (id: string, answer: string) => {
        if (answer === 'go' || answer === 'stop') app.onePasswordHeadsUp.answer(String(id), answer);
    });
    ipc.on(SEND.headsUpReady, () => app.headsUpWindow()?.resend());
}
