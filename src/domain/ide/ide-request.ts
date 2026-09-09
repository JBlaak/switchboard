/**
 * What the Claude CLI asks an editor to show.
 *
 * The CLI speaks a slice of MCP to whatever editor it discovers, and these two
 * requests are the ones Switchboard answers. They are described here rather
 * than beside either end of the wire because both ends need them: the bridge
 * that receives the call, and the panel that renders it.
 */

/** A file edit the CLI wants reviewed before it is applied. */
export interface DiffRequest {
  oldFilePath: string;
  /** Read from disk, not taken from the CLI — so the diff is against reality. */
  oldContent: string;
  newContent: string;
  tabName: string;
}

/** A file the CLI wants opened, optionally scrolled to a passage. */
export interface FileOpenRequest {
  filePath: string;
  content: string;
  preview: boolean;
  startText: string;
  endText: string;
}
