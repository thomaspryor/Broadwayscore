/** Monogram circle standing in for outlet logos (no third-party logos in the POC). */
export function OutletMark({ name }: { name: string }) {
  const clean = name.replace(/\(.*?\)/g, '').replace(/^The /, '').trim();
  const words = clean.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean);
  const caps = clean.replace(/[^A-Z]/g, '');
  const mono = (words.length > 1 ? words[0][0] + words[1][0] : caps.length >= 2 ? caps.slice(0, 2) : clean.slice(0, 2)).toUpperCase();
  return (
    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-bold tracking-tight text-white" aria-hidden="true">
      {mono}
    </span>
  );
}
