/** Monogram circle standing in for outlet logos (no third-party logos in the POC). */
export function OutletMark({ name }: { name: string }) {
  const letters = name.replace(/^The /, '').replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean);
  const mono = (letters.length > 1 ? letters[0][0] + letters[1][0] : letters[0].slice(0, 2)).toUpperCase();
  return (
    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-bold tracking-tight text-white" aria-hidden="true">
      {mono}
    </span>
  );
}
