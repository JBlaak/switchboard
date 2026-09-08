import fs from 'node:fs';
import path from 'node:path';

export function getFolderIndexMtimeMs(folderPath: string): number {
  let indexMtimeMs = 0;

  try {
    indexMtimeMs = fs.statSync(folderPath).mtimeMs;
  } catch {
    return 0;
  }

  try {
    // Session files are appended in place, which updates the file mtime but
    // often leaves the containing directory mtime unchanged.
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const fileMtimeMs = fs.statSync(path.join(folderPath, entry.name)).mtimeMs;
        if (fileMtimeMs > indexMtimeMs) indexMtimeMs = fileMtimeMs;
      } catch {}
    }
  } catch {}

  return indexMtimeMs;
}
