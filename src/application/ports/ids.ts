/**
 * Fresh identifiers, as a dependency.
 *
 * Session ids are UUIDs the CLI is handed on the command line and then writes
 * into its transcript, so they are part of the observable behaviour of a
 * launch — which makes them worth being able to fix in a test.
 */

export interface IdGenerator {
  newId(): string;
}

export const uuidGenerator: IdGenerator = {
  newId: () => crypto.randomUUID(),
};
