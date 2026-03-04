import { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Privacy Policy - Broadway Scorecard',
  description: 'Privacy policy for Broadway Scorecard website and mobile app.',
  alternates: { canonical: `${BASE_URL}/privacy` },
};

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="text-center mb-10">
        <h1 className="text-4xl sm:text-5xl font-extrabold text-white">Privacy Policy</h1>
        <p className="text-gray-400 mt-3">Last updated: March 3, 2026</p>
      </div>

      <div className="card p-6 sm:p-8 space-y-6">
        <section>
          <h2 className="text-xl font-bold text-white mb-3">Overview</h2>
          <p className="text-gray-300">
            Broadway Scorecard (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates the website
            broadwayscorecard.com and the Broadway Scorecard mobile application. We are committed to
            protecting your privacy. This policy explains what data we collect and how we use it.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-white mb-3">Data We Collect</h2>
          <div className="space-y-3 text-gray-300">
            <p><strong className="text-white">Website analytics:</strong> We use Google Analytics to
            collect anonymous usage data (pages visited, time on site, device type). This data is
            aggregated and cannot identify you personally.</p>
            <p><strong className="text-white">Mobile app:</strong> The Broadway Scorecard app does not
            collect any personal information. It fetches publicly available show data from our servers and
            caches it locally on your device for offline use. No account or sign-in is required.</p>
            <p><strong className="text-white">Email subscriptions:</strong> If you voluntarily subscribe
            to email updates, we store your email address to send you show alerts. You can unsubscribe
            at any time via the link in any email.</p>
            <p><strong className="text-white">User reviews:</strong> If you submit a review, we store
            your display name and review content. No email or account is required.</p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-white mb-3">Data We Do Not Collect</h2>
          <ul className="list-disc pl-5 space-y-2 text-gray-300">
            <li>We do not sell, share, or trade your personal information</li>
            <li>We do not use advertising trackers or third-party ad networks</li>
            <li>We do not collect location data, contacts, or device identifiers</li>
            <li>We do not require account creation to use the app or website</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-bold text-white mb-3">Local Storage</h2>
          <p className="text-gray-300">
            The mobile app stores cached show data on your device using local storage to enable offline
            access and faster loading. You can clear this cache at any time from the app&apos;s Settings
            screen. No personal data is stored locally.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-white mb-3">Third-Party Services</h2>
          <div className="space-y-2 text-gray-300">
            <p>We use the following third-party services:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong className="text-white">Google Analytics</strong> &mdash; anonymous website analytics</li>
              <li><strong className="text-white">Vercel</strong> &mdash; website hosting</li>
              <li><strong className="text-white">Expo / EAS</strong> &mdash; mobile app distribution</li>
            </ul>
            <p>Each service has its own privacy policy governing their handling of data.</p>
          </div>
        </section>

        <section>
          <h2 className="text-xl font-bold text-white mb-3">Children&apos;s Privacy</h2>
          <p className="text-gray-300">
            Our services are not directed at children under 13. We do not knowingly collect personal
            information from children.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-white mb-3">Changes to This Policy</h2>
          <p className="text-gray-300">
            We may update this policy from time to time. Changes will be posted on this page with an
            updated date. Your continued use of our services constitutes acceptance of any changes.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-bold text-white mb-3">Contact</h2>
          <p className="text-gray-300">
            If you have questions about this privacy policy, please reach out through our{' '}
            <Link href="/feedback" className="text-brand hover:underline">feedback page</Link>.
          </p>
        </section>
      </div>

      <div className="text-center mt-8">
        <Link href="/" className="text-brand hover:underline text-sm">
          &larr; Back to Broadway Scorecard
        </Link>
      </div>
    </div>
  );
}
