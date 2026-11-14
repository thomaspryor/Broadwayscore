// True when the module whose import.meta.url is passed was run directly
// (`node path/to/it.mjs`), false when imported. Node gives import.meta.url as
// the REAL path, so the bare `import.meta.url === \`file://${process.argv[1]}\``
// idiom is false whenever argv[1] goes through a symlink or contains a space
// or `%` (file URLs percent-encode): the CLI silently never runs. Hooks that
// shell out to such a CLI then read empty output and fail OPEN (found by
// BRO-2312's hermetic visual-gate fixture). review-gate.mjs uses it too.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  // Literal first: it needs no filesystem access, so an unrealpath-able argv1
  // (EACCES ancestor, file pruned mid-run) still matches when it can.
  if (importMetaUrl === pathToFileURL(argv1).href) return true;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}
