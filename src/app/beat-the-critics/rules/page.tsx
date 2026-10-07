import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Official Rules — Beat the Critics Prize Draw | Broadway Scorecard',
  alternates: { canonical: `${BASE_URL}/beat-the-critics/rules` },
  robots: { index: false },
};

export default function BeatTheCriticsRulesPage() {
  return (
    <div className="max-w-[680px] mx-auto px-5 py-12">
      <div className="mb-8">
        <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2">Beat the Critics</div>
        <h1 className="text-2xl font-extrabold tracking-tight mb-1">Official Rules — Prize Draw</h1>
        <p className="text-sm text-gray-500">$200 TodayTix Gift Card · Tony Awards 2026</p>
      </div>

      <div className="prose prose-invert prose-sm max-w-none space-y-6 text-gray-300 leading-relaxed">

        <p className="text-sm font-semibold text-white">No Purchase Necessary. Void where prohibited. Subject to all applicable federal, state, and local laws.</p>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">1. Eligibility</h2>
          <p className="text-sm">Open to legal residents of the fifty (50) United States and the District of Columbia who are 18 years of age or older at time of entry. Employees of Broadway Scorecard and members of their immediate families are not eligible.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">2. Entry Period</h2>
          <p className="text-sm">Entries are accepted beginning at 12:00 AM Eastern Time on May 18, 2026 and closing at 7:59 PM Eastern Time on June 7, 2026 (one minute before the Tony Awards ceremony broadcast begins). Entries submitted after that time will not be eligible for the prize draw.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">3. How to Enter</h2>
          <p className="text-sm">Visit <a href="https://broadwayscorecard.com/beat-the-critics" className="text-brand underline">broadwayscorecard.com/beat-the-critics</a>, complete at minimum the Best Musical, Best Play, Best Revival of a Musical, and Best Revival of a Play categories (Round 1), and provide your email address. You may continue through additional rounds to enter more categories, expanding the set compared against each critic. Limit one (1) entry per person. Entries submitted by automated means are void.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">4. Prize</h2>
          <p className="text-sm">One (1) winner will receive a TodayTix gift card valued at $200 USD. Prize is non-transferable. No cash equivalent or substitution, except at the sole discretion of Broadway Scorecard. Any gift card terms, expiration, and conditions are governed solely by TodayTix.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">5. Winner Selection</h2>
          <p className="text-sm">Following the Tony Award ceremony on June 8, 2026, one (1) winner will be selected at random from all eligible entries where the participant&apos;s prediction accuracy (correct picks divided by categories entered) exceeds the prediction accuracy of at least one (1) of the featured critics on those same categories. Participants who enter more categories are compared across a larger shared set. If no eligible entries meet this criterion, one (1) winner will be selected at random from all eligible entries. Odds of winning depend on the number of eligible entries received.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">6. Winner Notification</h2>
          <p className="text-sm">The winner will be notified by email within fourteen (14) days following the ceremony. If the selected winner does not respond within seven (7) days of notification, up to two (2) alternate winners may be selected using the same method.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">7. Privacy</h2>
          <p className="text-sm">By submitting your email, you will be added to the Broadway Scorecard mailing list and notified of your results after the ceremony. You may unsubscribe at any time. We will not share your email with third parties for marketing purposes.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">8. General Conditions</h2>
          <p className="text-sm">Broadway Scorecard reserves the right to cancel, modify, or suspend this promotion at any time. This promotion is in no way sponsored, endorsed, or administered by, or associated with TodayTix Group. By participating, entrants agree to be bound by these Official Rules and the decisions of Broadway Scorecard, which are final and binding. By accepting the prize, the winner releases Broadway Scorecard from any liability arising from use of the prize. This promotion is governed by the laws of the State of New York, without regard to conflicts of law.</p>
        </section>

        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider text-gray-400 mb-2">9. Sponsor</h2>
          <p className="text-sm">Broadway Scorecard · <a href="mailto:hi@broadwayscorecard.com" className="text-brand underline">hi@broadwayscorecard.com</a></p>
        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-white/10">
        <a href="/beat-the-critics" className="text-sm text-brand hover:underline">&larr; Back to Beat the Critics</a>
      </div>
    </div>
  );
}
