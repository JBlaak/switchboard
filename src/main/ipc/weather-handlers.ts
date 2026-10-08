/**
 * The weather for the empty screen, and resolving the city it is fetched for.
 */
import { INVOKE } from '../../ipc/channels';
import type { Container } from '../composition-root';
import type { IpcRegistrar } from './registrar';

export function registerWeatherHandlers(ipc: IpcRegistrar, app: Container): void {
  ipc.handle(INVOKE.getWeather, () => app.weather.current());
  ipc.handle(INVOKE.geocodeWeatherLocation, (name: string) => app.weather.geocode(name));
}
