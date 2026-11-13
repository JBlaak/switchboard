/**
 * One small record the agent keeps on disk as text, such as its self-started
 * sessions or the Merge manager's lane state (#438). A port so the services
 * that keep them stay testable and the application layer does no file I/O.
 */
export interface RecordFile {
    /** The file's text, or null when it does not exist or cannot be read. */
    read(): string | null;
    /** Replace the file's text, atomically and mode 0600; may throw. */
    write(text: string): void;
}
