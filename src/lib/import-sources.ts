/**
 * The apps My Shows can import a history from, in the order they are offered.
 * One list for every place that names them (the My Shows import link), so
 * adding a source here updates them all. The import window still owns each
 * source's own controls.
 */
export interface ImportSourceInfo {
  id: string;
  name: string;
}

export const IMPORT_SOURCES: readonly ImportSourceInfo[] = [
  { id: 'show-score', name: 'Show Score' },
  { id: 'mezzanine', name: 'Mezzanine' },
  { id: 'theatr', name: 'Theatr' },
];

/** "Show Score or Mezzanine", "Show Score, Mezzanine or Theatr". */
export function importSourceNames(sources: readonly Pick<ImportSourceInfo, 'name'>[] = IMPORT_SOURCES): string {
  const names = sources.map(s => s.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
