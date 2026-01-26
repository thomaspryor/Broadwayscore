import React from 'react';
import { CriticConsensus } from '@/lib/data';

interface CriticConsensusCardProps {
  consensus: CriticConsensus;
}

function QuoteIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
    </svg>
  );
}

export default function CriticConsensusCard({ consensus }: CriticConsensusCardProps) {
  return (
    <div className="card p-5 sm:p-6 mb-6" role="complementary" aria-label="Critics' Take">
      <div className="flex items-start gap-3 mb-3">
        <div className="text-brand/70 flex-shrink-0 mt-0.5" aria-hidden="true">
          <QuoteIcon />
        </div>
        <div>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">
            Critics&apos; Take
          </h2>
          <p className="text-gray-300 text-sm sm:text-base leading-relaxed">
            {consensus.text}
          </p>
        </div>
      </div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wide mt-3 pt-3 border-t border-white/5">
        Based on {consensus.reviewCount} {consensus.reviewCount === 1 ? 'review' : 'reviews'}
      </div>
    </div>
  );
}
