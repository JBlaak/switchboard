/**
 * Where new versions come from, and how one is put in place.
 */
import type {PublishedRelease} from '../../domain/update/release';
import type {PendingUpdate} from '../../domain/update/progress';

export interface ReleaseFeed {
    /** The newest published release; null when there is none. Rejects when it cannot be fetched. */
    latest(): Promise<PublishedRelease | null>;
}

/** A downloaded, unpacked and checked bundle, ready to swap in. */
export interface PreparedBundle {
    readonly path: string;
}

/** Told as each step of `prepare` starts, and as the download goes. */
export interface PrepareListener {
    /** Bytes of the zip so far, and its size when the server said. */
    downloaded(received: number, total: number | null): void;
    unpacking(): void;
    checking(): void;
}

export interface AppInstaller {
    /** False when this build cannot replace itself: not packaged, not a Mac, or no write access to its folder. */
    canInstall(): boolean;
    /**
     * Download and unpack the zip and check the bundle inside. Rejects when any
     * step fails, leaving the running app untouched and nothing behind.
     */
    prepare(downloadUrl: string, listener: PrepareListener): Promise<PreparedBundle>;
    /** Hand the swap to a helper and quit; the helper puts the bundle in place and relaunches it. */
    swapAndRestart(bundle: PreparedBundle): void;
}

/** The update handed to the swap, kept across the restart so the next launch can say how it went. */
export interface PendingUpdateStore {
    write(pending: PendingUpdate): Promise<void>;
    /** The pending update, removed as it is read; null when there is none. */
    take(): Promise<PendingUpdate | null>;
}
