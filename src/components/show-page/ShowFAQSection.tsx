'use client';

/**
 * PAA-style Q&A block — the visible counterpart to the FAQPage JSON-LD that
 * page.tsx emits (Google discounts FAQPage schema with no matching on-page
 * content). Native <details>/<summary> so it works without JS and stays
 * crawlable.
 *
 * Lives in its own module, not inline in ShowPageBelowFold, because the
 * below-fold chunk sits behind a shared ErrorBoundary: if any unrelated card
 * in that ~15-component tree throws, the boundary blanks the WHOLE chunk and
 * would silently take the FAQ with it while the schema in <head> survives —
 * exactly the schema/content divergence the block exists to prevent. The
 * loader's error fallback renders this component on its own so the two can
 * never disagree.
 *
 * Must stay 1:1 with getShowFAQs(), not a subset, or the schema advertises
 * Q&As Google can't find on the page.
 */
/** Shape returned by getShowFAQs() in @/lib/seo. */
export interface ShowFAQ {
  question: string;
  answer: string;
}

export default function ShowFAQSection({ faqs }: { faqs: ShowFAQ[] }) {
  if (faqs.length === 0) return null;
  return (
    <section className="card p-5 sm:p-6 mb-5 sm:mb-8" aria-labelledby="show-faq-heading">
      <h2 id="show-faq-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none mb-4">
        Frequently Asked Questions
      </h2>
      <div className="space-y-3" data-testid="show-faq-block">
        {faqs.map((faq, i) => (
          <details key={i} className="group border-b border-white/5 pb-3 last:border-0 last:pb-0">
            <summary className="text-sm font-medium text-gray-200 cursor-pointer list-none flex items-start justify-between gap-3 marker:content-none [&::-webkit-details-marker]:hidden">
              <span>{faq.question}</span>
              <span aria-hidden="true" className="text-gray-500 group-open:rotate-45 transition-transform shrink-0 leading-none">+</span>
            </summary>
            <p className="text-sm text-gray-400 leading-relaxed mt-2">{faq.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
