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
  openGraph: {
    title: 'Terms of Service — Broadway Scorecard',
    description: 'Terms of Service for Broadway Scorecard. Guidelines for acceptable use of our aggregated Broadway review scores and data.',
    url: `${BASE_URL}/terms`,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary',
    title: 'Terms of Service — Broadway Scorecard',
    description: 'Terms of Service for Broadway Scorecard.',
  },
};

const linkClass = 'text-amber-400 hover:text-amber-300 transition-colors';

export default function TermsOfServicePage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
      <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Terms of Service</h1>
      <p className="text-sm text-gray-500 mb-10">Last updated: April 15, 2026</p>

      <div className="prose prose-invert prose-gray max-w-none space-y-8 text-gray-300 leading-relaxed">

        {/* 1. Acceptance */}
        <section>
          <h2 className="text-xl font-semibold text-white mt-0">1. Acceptance of Terms</h2>
          <p>
            By accessing or using Broadway Scorecard (<Link href="/" className={linkClass}>broadwayscorecard.com</Link>),
            you agree to be bound by these Terms of Service. If you do not agree, please do not use the site.
          </p>
        </section>

        {/* 2. Definitions */}
        <section>
          <h2 className="text-xl font-semibold text-white">2. Definitions</h2>
          <p>
            <strong className="text-white">&ldquo;Score Data&rdquo;</strong> means any Broadway Scorecard composite score,
            sub-score, sentiment score, tier designation, ranking position, normalized value, or any derivative or variant
            thereof displayed on the Site.
          </p>
          <p>
            <strong className="text-white">&ldquo;Rankings&rdquo;</strong> means ordered lists of shows, leaderboards,
            category lists, &ldquo;best of&rdquo; lists, and historical rank data.
          </p>
          <p>
            <strong className="text-white">&ldquo;Database&rdquo;</strong> means the structured collection of Score Data
            and linked metadata — including shows, dates, sources, tiers, normalization outputs, and identifiers — whether
            publicly visible or not.
          </p>
          <p>
            <strong className="text-white">&ldquo;Commercial Use&rdquo;</strong> means any use in connection with a product
            or service, advertising, revenue generation, subscription access, lead generation, paid newsletters, or internal
            business intelligence.
          </p>
          <p>
            <strong className="text-white">&ldquo;Bulk Extraction&rdquo;</strong> means copying or collecting Score Data
            for more than five (5) shows in a 24-hour period, or more than twenty (20) shows in a calendar month, by any
            means — automated or manual.
          </p>
        </section>

        {/* 3. Limited License */}
        <section>
          <h2 className="text-xl font-semibold text-white">3. Limited License &amp; Permitted Use</h2>
          <p>
            Subject to these Terms, Broadway Scorecard grants you a limited, revocable, non-exclusive, non-transferable
            license to access and use the Site and its content solely for personal, non-commercial use. You may:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Browse and read content on the site</li>
            <li>Share links to individual show pages or articles</li>
            <li>
              Reference a single Score Data point in a bona fide editorial context (article, review, blog post, social
              media post) with attribution to Broadway Scorecard and a link to the relevant show page — provided you do
              not publish Score Data for multiple shows in a table, database, directory, or recurring format
            </li>
            <li>Use the site to inform personal ticket-buying decisions</li>
            <li>
              <strong className="text-white">Use the Official Embed Program</strong> (Section 3a) to display CriticScore
              badges on third-party websites, blogs, and applications — subject to the conditions in Section 3a
            </li>
          </ul>
          <p className="font-medium text-white">
            All rights not expressly granted herein are reserved by Broadway Scorecard LLC.
          </p>
        </section>

        {/* 3a. Official Embed Program */}
        <section>
          <h2 className="text-xl font-semibold text-white">3a. Official Embed Program</h2>
          <p>
            Broadway Scorecard provides hosted embed endpoints that you may use — free of charge, without a written
            agreement — to display a single show&apos;s CriticScore on a third-party website, blog, email newsletter,
            or application, subject to the following conditions:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong className="text-white">Use the official endpoints.</strong> Embeds must load content from
              <code className="text-xs text-brand mx-1">broadwayscorecard.com/embed/&#123;slug&#125;</code> (iframe) or
              <code className="text-xs text-brand mx-1">broadwayscorecard.com/api/badge/&#123;slug&#125;</code> (SVG).
              Do not proxy, mirror, cache, or rehost these URLs.
            </li>
            <li>
              <strong className="text-white">Attribution must remain intact.</strong> The embed includes the text
              &ldquo;CriticScore™ by Broadway Scorecard&rdquo; linking back to our site. You may not remove, obscure,
              alter, or visually suppress this text or link.
            </li>
            <li>
              <strong className="text-white">The lockup stays together.</strong> The score number, tier color, tier
              label, and attribution travel as a single unit. Do not strip any element, recolor the badge, or present
              the score number without its tier context.
            </li>
            <li>
              <strong className="text-white">No modification of values.</strong> Do not alter, normalize, round
              differently, or transform Score Data pulled from these endpoints. Do not present stale values — use the
              live embed so scores update automatically.
            </li>
            <li>
              <strong className="text-white">Per-page limit.</strong> A single page or screen may display badges for
              a single show (the show that page is about), or — with prior written consent — a bounded list of shows
              directly relevant to that page&apos;s editorial subject. This license does not permit directories,
              leaderboards, or tables of CriticScores.
            </li>
            <li>
              <strong className="text-white">No derivative indexes.</strong> You may not aggregate, compile, or
              cross-reference embedded scores with other data to create a ranking product, recommendation engine, or
              search feature.
            </li>
            <li>
              <strong className="text-white">We may revoke embed access.</strong> We may disable embed endpoints for
              specific domains or IPs at any time, with or without notice, if we determine these conditions have been
              violated.
            </li>
          </ul>
          <p>
            Copy-paste snippets and a live preview are available at{' '}
            <Link href="/partners" className={linkClass}>broadwayscorecard.com/partners</Link>. Embedding the endpoints
            constitutes acceptance of these conditions.
          </p>
          <p>
            <strong className="text-white">Bulk or large-scale embedding</strong> (multiple shows per page, database-
            style integration, API-level access to Score Data) continues to require a separate written licensing
            agreement — see Section 6.
          </p>
        </section>

        {/* 4. Prohibited Use */}
        <section>
          <h2 className="text-xl font-semibold text-white">4. Prohibited Use</h2>
          <p>
            The following activities are strictly prohibited without a prior written licensing agreement with Broadway Scorecard LLC:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong className="text-white">Automated data collection:</strong> Scraping, crawling, or harvesting of Score Data,
              reviews, or any structured data using bots, scripts, scrapers, spiders, or any automated means
            </li>
            <li>
              <strong className="text-white">Manual bulk extraction:</strong> Systematic manual copying, transcription, or compilation
              of Score Data, Rankings, or Database content — whether by hand or through any organized effort — exceeding the thresholds
              defined in Section 2
            </li>
            <li>
              <strong className="text-white">Unauthorized commercial display:</strong> Displaying, embedding, syndicating, or integrating
              Score Data, Rankings, or Database content on any third-party website, application, platform, API, widget, tooltip, badge, or product —
              <em className="text-gray-200"> except via the Official Embed Program described in Section 3a, subject to its conditions</em>
            </li>
            <li>
              <strong className="text-white">Caching or storing:</strong> Caching, storing, or archiving Score Data for the purpose of
              reuse, display, or redistribution
            </li>
            <li>
              <strong className="text-white">Reproduction or redistribution:</strong> Reproducing or redistributing Score Data, Rankings,
              or Database content in any form — including in competing products, apps, APIs, newsletters, databases, datasets, or directories
            </li>
            <li>
              <strong className="text-white">Competing indexes:</strong> Creating competing critic score indexes, aggregation products, or
              score-derived datasets using extracted Score Data
            </li>
            <li>
              <strong className="text-white">Model training:</strong> Using Score Data or Database content to train, fine-tune, or evaluate
              machine learning models
            </li>
            <li>
              <strong className="text-white">Circumvention:</strong> Circumventing any rate limits, bot protections, access controls, or
              technical restrictions on the Site
            </li>
            <li>
              <strong className="text-white">Indexing or supplementing:</strong> Using Score Data to supplement, enhance, verify, or populate
              any third-party database, search index, recommendation engine, or ranking system
            </li>
            <li>
              <strong className="text-white">Derived use as input:</strong> Using Score Data, Rankings, or tier designations as an input,
              signal, or sorting criterion for any third-party algorithm, ranking product, or recommendation system
            </li>
            <li>
              <strong className="text-white">Mirroring or framing:</strong> Mirroring or framing any portion of the Site
            </li>
            <li>
              <strong className="text-white">Reverse engineering:</strong> Reverse engineering, deriving, or attempting to replicate our
              scoring methodology through systematic observation, extraction, or analysis
            </li>
          </ul>
        </section>

        {/* 5. Intellectual Property */}
        <section>
          <h2 className="text-xl font-semibold text-white">5. Intellectual Property</h2>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Composite Scores, Rankings, and Database</h3>
          <p>
            The Site includes proprietary composite scores and related outputs (Score Data), Rankings, and a structured
            Database of show-level information. While underlying review texts and individual factual statements remain the
            property of their respective owners, Broadway Scorecard&apos;s selection of sources, tiering, weighting,
            normalization, categorization, and presentation of results reflect original editorial judgment and creative
            choices. To the maximum extent permitted by law, the Database, Rankings, and the selection, coordination,
            arrangement, and presentation of Score Data are protected by copyright and other applicable intellectual
            property rights.
          </p>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Methodology and Trade Secrets</h3>
          <p>
            The scoring methodology, model prompts and configuration, weighting schemes, normalization procedures, source
            tier assignments, and other non-public aspects of our process constitute proprietary confidential information
            and trade secrets of Broadway Scorecard LLC, to the extent not publicly disclosed. You may not reverse engineer,
            derive, or attempt to replicate these through systematic observation, extraction, or analysis.
          </p>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Third-Party Content</h3>
          <p>
            Individual review excerpts, quotes, and ratings referenced on Broadway Scorecard remain the property of their
            respective publications and critics. We aggregate publicly available critical assessments and provide attribution
            and links to original sources.
          </p>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Trademarks</h3>
          <p>
            Broadway Scorecard™, CriticScore™, AudienceGrade™, Critical Gold™, Broadway Scorecard Gold List™,
            and associated logos are trademarks of Broadway Scorecard LLC.
            No trademark license is granted by these Terms.
          </p>
        </section>

        {/* 6. Data Licensing */}
        <section>
          <h2 className="text-xl font-semibold text-white">6. Data Licensing &amp; Commercial Partnerships</h2>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">No Implied License</h3>
          <p>
            Except as expressly permitted in Section 3, no license or other rights to Score Data, Rankings, or the Database
            are granted by implication, estoppel, or otherwise. Attribution to Broadway Scorecard does not authorize reuse,
            republication, or commercial display of Score Data. Attribution does not cure unauthorized use.
          </p>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Commercial Display Requires a Written License</h3>
          <p>
            Any Commercial Use, reproduction, distribution, display, embedding, syndication, or integration of Score Data,
            Rankings, or Database content — including in apps, websites, search result features, newsletters, APIs, or
            internal tools — requires a separate written licensing agreement signed by Broadway Scorecard LLC.
          </p>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">No Rights From Conversations</h3>
          <p>
            Meetings, emails, direct messages, or discussions — including partnership conversations — do not grant any
            rights to Score Data, Rankings, or the Database unless and until a separate written licensing agreement is
            executed by both parties.
          </p>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Licensing Inquiries</h3>
          <p>
            For commercial licensing, partnership proposals, or API access requests, please contact us via
            the <Link href="/feedback" className={linkClass}>feedback form</Link>.
          </p>
        </section>

        {/* 7. Enforcement */}
        <section>
          <h2 className="text-xl font-semibold text-white">7. Enforcement</h2>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Unauthorized Use</h3>
          <p>
            If Broadway Scorecard discovers unauthorized use of Score Data, Rankings, Database content, or other intellectual
            property, it reserves the right to:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Demand prompt removal of infringing content</li>
            <li>Block access to broadwayscorecard.com</li>
            <li>Pursue legal remedies including injunctive relief, damages, and recovery of attorneys&apos; fees</li>
          </ul>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Irreparable Harm</h3>
          <p>
            You acknowledge that unauthorized Commercial Use, reproduction, or distribution of Score Data, Rankings, or
            Database content would cause irreparable harm to Broadway Scorecard LLC for which monetary damages may be an
            insufficient remedy, and that Broadway Scorecard LLC may seek injunctive or other equitable relief without the
            necessity of posting bond.
          </p>

          <h3 className="text-lg font-medium text-white mt-6 mb-2">Attorneys&apos; Fees</h3>
          <p>
            In any action to enforce these Terms, the prevailing party shall be entitled to recover reasonable
            attorneys&apos; fees and costs from the non-prevailing party.
          </p>
        </section>

        {/* 8. Affiliate Links */}
        <section>
          <h2 className="text-xl font-semibold text-white">8. Affiliate Links &amp; Ticket Purchases</h2>
          <p>
            Broadway Scorecard may contain affiliate links to ticket sellers and other third-party products. We may earn a
            commission when you make a purchase through these links at no additional cost to you. Ticket purchases are
            subject to the terms and conditions of the respective ticket seller. Broadway Scorecard is not responsible for
            ticket availability, pricing, or fulfillment.
          </p>
        </section>

        {/* 9. Disclaimer */}
        <section>
          <h2 className="text-xl font-semibold text-white">9. Disclaimer</h2>
          <p>
            Broadway Scorecard is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo; without warranty of any kind,
            express or implied, including but not limited to the implied warranties of merchantability, fitness for a
            particular purpose, and non-infringement. Scores are derived from publicly available critic reviews using
            our <Link href="/methodology" className={linkClass}>scoring methodology</Link> and may not reflect every
            published review. We make reasonable efforts to ensure accuracy but do not guarantee completeness or error-free
            operation.
          </p>
        </section>

        {/* 10. Limitation of Liability */}
        <section>
          <h2 className="text-xl font-semibold text-white">10. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, Broadway Scorecard LLC and its owners, operators, and contributors
            shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising from your
            use of the site, reliance on any Score Data or content, or any ticket purchases made through links on the site.
          </p>
        </section>

        {/* 11. Governing Law */}
        <section>
          <h2 className="text-xl font-semibold text-white">11. Governing Law</h2>
          <p>
            These Terms of Service are governed by the laws of the State of New York, without regard to conflict of law
            principles. Any disputes arising from these Terms or your use of Broadway Scorecard shall be resolved in the
            courts located in New York County, New York.
          </p>
        </section>

        {/* 12. General Provisions */}
        <section>
          <h2 className="text-xl font-semibold text-white">12. General Provisions</h2>
          <p>
            <strong className="text-white">Severability.</strong> If any provision of these Terms is found unenforceable,
            the remaining provisions shall continue in full force and effect.
          </p>
          <p>
            <strong className="text-white">Waiver.</strong> Failure to enforce any provision of these Terms does not
            constitute a waiver of that provision or any other provision.
          </p>
          <p>
            <strong className="text-white">Entire Agreement.</strong> These Terms constitute the entire agreement between
            you and Broadway Scorecard LLC regarding your use of the Site, superseding any prior agreements.
          </p>
          <p>
            <strong className="text-white">Assignment.</strong> Broadway Scorecard LLC may assign these Terms without
            restriction. You may not assign your rights or obligations under these Terms.
          </p>
        </section>

        {/* 13. Changes */}
        <section>
          <h2 className="text-xl font-semibold text-white">13. Changes to Terms</h2>
          <p>
            We may update these Terms from time to time. Continued use of the Site after changes constitutes acceptance of
            the updated terms. Material changes will be noted by updating the &ldquo;Last updated&rdquo; date at the top
            of this page.
          </p>
        </section>

        {/* Footer */}
        <div className="border-t border-white/10 pt-6 mt-10 text-center text-sm text-gray-500">
          <p>&copy; 2026 Broadway Scorecard LLC. All rights reserved.</p>
          <p className="mt-1">broadwayscorecard.com</p>
        </div>
      </div>
    </div>
  );
}
