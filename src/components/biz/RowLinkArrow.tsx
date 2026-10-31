/**
 * RowLinkArrow - chevron after a show or season name in the Profitability Scorecard
 * tables and lists, so rows read as links (owner, 2026-10-26). Turns brand
 * colored when its row or link (a `group`) is hovered. Pass the name as
 * `label` to keep the chevron on the same line as the name's last word (a
 * bare chevron wrapped onto its own line in narrow table columns).
 */
function Chevron() {
  return (
    <svg
      className="inline-block w-3.5 h-3.5 ml-1 -mt-0.5 text-fg-muted group-hover:text-brand transition-colors"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
    </svg>
  );
}

export default function RowLinkArrow({ label }: { label?: string }) {
  if (!label) return <Chevron />;
  const cut = label.trimEnd().lastIndexOf(' ');
  const head = cut >= 0 ? label.slice(0, cut + 1) : '';
  const last = cut >= 0 ? label.slice(cut + 1) : label;
  return (
    <>
      {head}
      <span className="whitespace-nowrap">
        {last}
        <Chevron />
      </span>
    </>
  );
}
