'use client';

import type { ShowLotteryRush } from '@/lib/data-types';
import { ensureHttps } from '@/lib/url-utils';
import { buildAffiliateUrl } from '@/lib/affiliate-utils';
import { getCurrencySymbol } from '@/lib/market-utils';

interface LotteryRushCardProps {
  data: ShowLotteryRush;
  showStatus: string;
  showCategory?: string;
}

function TicketIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

function DiceIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function LocationIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
}



export default function LotteryRushCard({ data, showStatus, showCategory }: LotteryRushCardProps) {
  const currency = getCurrencySymbol(showCategory);
  // Don't show for closed shows
  if (showStatus === 'closed') return null;

  const hasLottery = data.lottery || data.specialLottery;
  const hasRush = data.rush || data.digitalRush || data.studentRush;
  const hasSRO = data.standingRoom;

  // Don't render if no options available
  if (!hasLottery && !hasRush && !hasSRO) return null;

  return (
    <section id="discount-tickets" className="card p-5 sm:p-6 mb-6 scroll-mt-20" aria-labelledby="lottery-rush-heading">
      <h2 id="lottery-rush-heading" className="text-lg font-bold text-white mb-4 flex items-center gap-2">
        <TicketIcon />
        Discount Tickets
      </h2>

      <div className="space-y-4">
        {/* Lottery Section */}
        {data.lottery && (
          <div className="bg-purple-500/15 border border-purple-500/20 rounded-lg p-4 hover:bg-purple-500/20 transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <DiceIcon />
                <h3 className="font-semibold text-purple-300">Digital Lottery</h3>
              </div>
              <span className="text-xl font-bold text-white">{currency}{data.lottery.price}</span>
            </div>
            <div className="space-y-2 text-sm">
              {data.lottery.time && (
              <div className="flex items-start gap-2 text-gray-400">
                <ClockIcon />
                <span>{data.lottery.time}</span>
              </div>
              )}
              {data.lottery.instructions && <p className="text-gray-400">{data.lottery.instructions}</p>}
              {data.lottery.url && (
                <a
                  href={buildAffiliateUrl(ensureHttps(data.lottery.url)!, data.lottery.platform || '', 'lottery').url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-purple-400 hover:text-purple-300 font-medium transition-colors mt-1"
                >
                  {data.lottery.platform ? `Enter on ${data.lottery.platform}` : 'Enter lottery'}
                  <ExternalLinkIcon />
                </a>
              )}
            </div>
          </div>
        )}

        {/* Special Lottery (e.g., anniversary lottery) */}
        {data.specialLottery && (
          <div className="bg-amber-500/15 border border-amber-500/20 rounded-lg p-4 hover:bg-amber-500/20 transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <DiceIcon />
                <h3 className="font-semibold text-amber-300">{data.specialLottery.name}</h3>
              </div>
              <span className="text-xl font-bold text-white">{currency}{data.specialLottery.price}</span>
            </div>
            <div className="space-y-2 text-sm">
              {data.specialLottery.instructions && <p className="text-gray-400">{data.specialLottery.instructions}</p>}
              {data.specialLottery.url && (
                <a
                  href={buildAffiliateUrl(ensureHttps(data.specialLottery.url)!, data.specialLottery.platform || '', 'lottery').url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-amber-400 hover:text-amber-300 font-medium transition-colors mt-1"
                >
                  {data.specialLottery.platform ? `Enter on ${data.specialLottery.platform}` : 'Enter lottery'}
                  <ExternalLinkIcon />
                </a>
              )}
            </div>
          </div>
        )}

        {/* Rush Section */}
        {data.rush && (
          <div className="bg-emerald-500/15 border border-emerald-500/20 rounded-lg p-4 hover:bg-emerald-500/20 transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <TicketIcon />
                <h3 className="font-semibold text-emerald-300">
                  {data.rush.type === 'general' ? 'Box Office Rush' : 'Rush Tickets'}
                </h3>
              </div>
              <span className="text-xl font-bold text-white">{currency}{data.rush.price}</span>
            </div>
            <div className="space-y-2 text-sm">
              {data.rush.time && (
              <div className="flex items-start gap-2 text-gray-400">
                <ClockIcon />
                <span>{data.rush.time}</span>
              </div>
              )}
              {data.rush.location && (
                <div className="flex items-start gap-2 text-gray-400">
                  <LocationIcon />
                  <span>{data.rush.location}</span>
                </div>
              )}
              {data.rush.instructions && <p className="text-gray-400">{data.rush.instructions}</p>}
              {data.rush.url && (
                <a
                  href={buildAffiliateUrl(ensureHttps(data.rush.url)!, data.rush.platform || '', 'rush').url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 font-medium transition-colors mt-1"
                >
                  {data.rush.platform ? `Get on ${data.rush.platform}` : 'More info'}
                  <ExternalLinkIcon />
                </a>
              )}
            </div>
          </div>
        )}

        {/* Digital Rush (separate from box office rush) */}
        {data.digitalRush && (
          <div className="bg-blue-500/15 border border-blue-500/20 rounded-lg p-4 hover:bg-blue-500/20 transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <TicketIcon />
                <h3 className="font-semibold text-blue-300">Digital Rush</h3>
              </div>
              <span className="text-xl font-bold text-white">{currency}{data.digitalRush.price}</span>
            </div>
            <div className="space-y-2 text-sm">
              {data.digitalRush.time && (
              <div className="flex items-start gap-2 text-gray-400">
                <ClockIcon />
                <span>{data.digitalRush.time}</span>
              </div>
              )}
              {data.digitalRush.instructions && <p className="text-gray-400">{data.digitalRush.instructions}</p>}
              {data.digitalRush.url && (
                <a
                  href={buildAffiliateUrl(ensureHttps(data.digitalRush.url)!, data.digitalRush.platform || '', 'rush').url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-blue-400 hover:text-blue-300 font-medium transition-colors mt-1"
                >
                  {data.digitalRush.platform ? `Get on ${data.digitalRush.platform}` : 'Get rush tickets'}
                  <ExternalLinkIcon />
                </a>
              )}
            </div>
          </div>
        )}

        {/* Student Rush */}
        {data.studentRush && (
          <div className="bg-pink-500/15 border border-pink-500/20 rounded-lg p-4 hover:bg-pink-500/20 transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <TicketIcon />
                <h3 className="font-semibold text-pink-300">Student Rush</h3>
              </div>
              <span className="text-xl font-bold text-white">{currency}{data.studentRush.price}</span>
            </div>
            <div className="space-y-2 text-sm">
              {data.studentRush.time && (
              <div className="flex items-start gap-2 text-gray-400">
                <ClockIcon />
                <span>{data.studentRush.time}</span>
              </div>
              )}
              {data.studentRush.location && (
                <div className="flex items-start gap-2 text-gray-400">
                  <LocationIcon />
                  <span>{data.studentRush.location}</span>
                </div>
              )}
              {data.studentRush.instructions && <p className="text-gray-400">{data.studentRush.instructions}</p>}
            </div>
          </div>
        )}

        {/* Standing Room */}
        {data.standingRoom && (
          <div className="bg-gray-500/15 border border-gray-500/20 rounded-lg p-4 hover:bg-gray-500/20 transition-colors">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <TicketIcon />
                <h3 className="font-semibold text-gray-300">Standing Room</h3>
              </div>
              <span className="text-xl font-bold text-white">{currency}{data.standingRoom.price}</span>
            </div>
            <div className="space-y-2 text-sm">
              {data.standingRoom.time && (
              <div className="flex items-start gap-2 text-gray-400">
                <ClockIcon />
                <span>{data.standingRoom.time}</span>
              </div>
              )}
              {data.standingRoom.instructions && <p className="text-gray-400">{data.standingRoom.instructions}</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
