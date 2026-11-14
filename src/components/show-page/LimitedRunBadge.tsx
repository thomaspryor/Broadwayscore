// Limited Run pill for shows with a fixed, short engagement. Shared by the
// redesigned hero and the legacy header so both render the same badge.
export default function LimitedRunBadge() {
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide bg-rose-500/15 text-rose-400 border border-rose-500/30">
      LIMITED RUN
    </span>
  );
}
