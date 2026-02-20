import { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Terms of Service - Broadway Scorecard',
  description: 'Terms of Service for Broadway Scorecard. Guidelines for acceptable use of our aggregated Broadway review scores and data.',
  alternates: {
    canonical: `${BASE_URL}/terms`,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function TermsOfServicePage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
      <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: February 20, 2026</p>

      <div className="prose prose-invert prose-gray max-w-none space-y-8 text-gray-300 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-white mt-0">1. Acceptance of Terms</h2>
          <p>
            By accessing or using Broadway Scorecard (<Link href="/" className="text-amber-400 hover:text-amber-300">broadwayscorecard.com</Link>),
            you agree to be bound by these Terms of Service. If you do not agree, please do not use the site.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-white">2. Permitted Use</h2>
          <p>
            Broadway Scorecard is provided for personal, non-commercial use. You may:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Browse and read content on the site</li>
            <li>Share links to individual show pages or articles</li>
            <li>Reference individual scores with attribution to Broadway Scorecard</li>
            <li>Use the site to inform personal ticket-buying decisions</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-white">3. Prohibited Use</h2>
          <p>
            The following activities are strictly prohibited without prior written consent:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              <strong className="text-white">Automated scraping or crawling</strong> of scores, reviews, or any structured data
              using bots, scripts, scrapers, or any automated means
            </li>
            <li>
              <strong className="text-white">Bulk data extraction</strong> or systematic downloading of aggregated scores,
              review data, commercial data, or audience data
            </li>
            <li>
              <strong className="text-white">Reproduction or redistribution</strong> of our aggregated scores, rankings,
              or datasets in any form — including in competing products, apps, APIs, or databases
            </li>
            <li>
              <strong className="text-white">Commercial use</strong> of our data, scores, or rankings without a licensing agreement
            </li>
            <li>
              <strong className="text-white">Mirroring or framing</strong> any portion of the site
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-white">4. Intellectual Property</h2>
          <p>
            The composite scores, tier-weighted methodology, editorial summaries, audience analysis,
            and all other original content on Broadway Scorecard are the intellectual property of Broadway Scorecard.
          </p>
          <p>
            Individual review excerpts and quotes remain the property of their respective publications and critics.
            We aggregate publicly available critical assessments and provide attribution to original sources.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-white">5. Attribution</h2>
          <p>
            If you reference Broadway Scorecard scores in editorial content (articles, blog posts, social media),
            please include attribution such as &ldquo;according to Broadway Scorecard&rdquo; or a link to the relevant show page.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-white">6. Data Licensing</h2>
          <p>
            For commercial licensing inquiries, partnership proposals, or API access requests,
            please contact us via the{' '}
            <Link href="/feedback" className="text-amber-400 hover:text-amber-300">feedback form</Link>.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-white">7. Disclaimer</h2>
          <p>
            Broadway Scorecard is provided &ldquo;as is&rdquo; without warranty of any kind. Scores are derived from
            publicly available critic reviews using our{' '}
            <Link href="/methodology" className="text-amber-400 hover:text-amber-300">scoring methodology</Link>{' '}
            and may not reflect every published review. We make reasonable efforts to ensure accuracy
            but do not guarantee completeness.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-white">8. Changes to Terms</h2>
          <p>
            We may update these terms from time to time. Continued use of the site after changes
            constitutes acceptance of the updated terms.
          </p>
        </section>
      </div>
    </div>
  );
}
