/**
 * The apps My Shows can import a history from, in the order they are offered.
 * One list for every place that names them (the import window's title, the
 * welcome sheet's cards and copy), so adding a source here updates them all.
 * The import window still owns each source's own controls.
 */
export interface ImportSourceInfo {
  id: string;
  name: string;
  icon: string;
  /** One line on what the person needs to have ready. */
  hint: string;
}

export const IMPORT_SOURCES: readonly ImportSourceInfo[] = [
  { id: 'show-score', name: 'Show Score', icon: '🎭', hint: 'Paste your public profile link. No password needed.' },
  { id: 'mezzanine', name: 'Mezzanine', icon: '📱', hint: 'Upload the JSON file from Settings → Export Data.' },
  { id: 'theatr', name: 'Theatr', icon: '📸', hint: 'Upload screenshots of your Theatr diary.' },
];

/** "Show Score or Mezzanine", "Show Score, Mezzanine or Theatr". */
export function importSourceNames(sources: readonly Pick<ImportSourceInfo, 'name'>[] = IMPORT_SOURCES): string {
  const names = sources.map(s => s.name);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
