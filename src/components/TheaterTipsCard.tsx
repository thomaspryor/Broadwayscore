'use client';

import { useState } from 'react';
import type { TheaterStructuredTips } from '@/lib/data-types';

interface TheaterTipsCardProps {
  tips: TheaterStructuredTips;
  fallbackTips?: string;
}

// ============================================
// Icons
// ============================================

function SeatIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
    </svg>
  );
}

function ParkingIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  );
}

function ForkKnifeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  );
}

function SubwayIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  );
}

function WalkIcon() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
    </svg>
  );
}

// ============================================
// Tab definitions
// ============================================

type TabKey = 'seating' | 'parking' | 'dining' | 'logistics';

// Explicit class maps — Tailwind JIT can't detect dynamic class construction
const TAB_ACTIVE_CLASSES: Record<TabKey, string> = {
  seating: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
  parking: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  dining: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  logistics: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
};

const TAB_CONFIG: Record<TabKey, { label: string; icon: React.ReactNode }> = {
  seating: { label: 'Seating', icon: <SeatIcon /> },
  parking: { label: 'Parking', icon: <ParkingIcon /> },
  dining: { label: 'Dining', icon: <ForkKnifeIcon /> },
  logistics: { label: 'Getting There', icon: <SubwayIcon /> },
};

// ============================================
// Sub-components
// ============================================

function SeatingTab({ seating }: { seating: NonNullable<TheaterStructuredTips['seating']> }) {
  return (
    <div className="space-y-3">
      {seating.bestSeats && (
        <div className="flex items-start gap-2">
          <CheckIcon />
          <div>
            <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-0.5">Best Seats</p>
            <p className="text-sm text-gray-300">{seating.bestSeats}</p>
          </div>
        </div>
      )}
      {seating.avoidSeats && (
        <div className="flex items-start gap-2">
          <WarningIcon />
          <div>
            <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider mb-0.5">Seats to Avoid</p>
            <p className="text-sm text-gray-300">{seating.avoidSeats}</p>
          </div>
        </div>
      )}
      {seating.accessibility && (
        <div className="flex items-start gap-2">
          <svg className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-0.5">Accessibility</p>
            <p className="text-sm text-gray-300">{seating.accessibility}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ParkingTab({ parking }: { parking: NonNullable<TheaterStructuredTips['parking']> }) {
  return (
    <div className="space-y-3">
      {parking.nearestGarages && parking.nearestGarages.length > 0 && (
        <div className="space-y-2">
          {parking.nearestGarages.map((garage, i) => (
            <div key={i} className="flex items-center justify-between bg-blue-500/10 rounded-lg px-3 py-2">
              <span className="text-sm text-gray-200">{garage.name}</span>
              {garage.walkMinutes != null && (
                <span className="flex items-center gap-1 text-xs text-blue-400 font-medium whitespace-nowrap ml-2">
                  <WalkIcon />
                  {garage.walkMinutes} min
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {parking.streetParking && (
        <p className="text-sm text-gray-400">{parking.streetParking}</p>
      )}
      {parking.tip && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
          <p className="text-sm text-blue-300">{parking.tip}</p>
        </div>
      )}
    </div>
  );
}

function DiningTab({ dining }: { dining: NonNullable<TheaterStructuredTips['dining']> }) {
  const sections: { key: keyof typeof dining; label: string; labelClass: string }[] = [
    { key: 'preShow', label: 'Pre-Show', labelClass: 'text-amber-400' },
    { key: 'postShow', label: 'Post-Show', labelClass: 'text-purple-400' },
    { key: 'quickBite', label: 'Quick Bite', labelClass: 'text-emerald-400' },
  ];

  return (
    <div className="space-y-4">
      {sections.map(({ key, label, labelClass }) => {
        const restaurants = dining[key];
        if (!restaurants || restaurants.length === 0) return null;
        return (
          <div key={key}>
            <p className={`text-xs font-semibold ${labelClass} uppercase tracking-wider mb-2`}>{label}</p>
            <div className="space-y-2">
              {restaurants.map((r, i) => (
                <div key={i} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-200">{r.name}</p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                      {r.cuisine && <span className="text-xs text-gray-500">{r.cuisine}</span>}
                      {r.priceRange && <span className="text-xs text-gray-500">{r.priceRange}</span>}
                    </div>
                    {r.notes && <p className="text-xs text-gray-500 mt-0.5">{r.notes}</p>}
                  </div>
                  {r.walkMinutes != null && (
                    <span className="flex items-center gap-1 text-xs text-amber-400 font-medium whitespace-nowrap mt-0.5">
                      <WalkIcon />
                      {r.walkMinutes} min
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LogisticsTab({ logistics }: { logistics: NonNullable<TheaterStructuredTips['logistics']> }) {
  const items: { label: string; value: string; labelClass: string }[] = [
    logistics.nearestSubway ? { label: 'Nearest Subway', value: logistics.nearestSubway, labelClass: 'text-emerald-400' } : null,
    logistics.entrance ? { label: 'Entrance', value: logistics.entrance, labelClass: 'text-blue-400' } : null,
    logistics.exitStrategy ? { label: 'Exit Strategy', value: logistics.exitStrategy, labelClass: 'text-purple-400' } : null,
    logistics.restrooms ? { label: 'Restrooms', value: logistics.restrooms, labelClass: 'text-gray-400' } : null,
  ].filter((item): item is { label: string; value: string; labelClass: string } => item !== null);

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i}>
          <p className={`text-xs font-semibold ${item.labelClass} uppercase tracking-wider mb-0.5`}>{item.label}</p>
          <p className="text-sm text-gray-300">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

// ============================================
// Main component
// ============================================

export default function TheaterTipsCard({ tips, fallbackTips }: TheaterTipsCardProps) {
  // Determine which tabs have content
  const availableTabs = (Object.keys(TAB_CONFIG) as TabKey[]).filter(key => {
    if (key === 'seating') return !!tips.seating;
    if (key === 'parking') return !!tips.parking;
    if (key === 'dining') return !!tips.dining;
    if (key === 'logistics') return !!tips.logistics;
    return false;
  });

  const [activeTab, setActiveTab] = useState<TabKey>(availableTabs[0] || 'seating');

  // If no structured tips at all, show fallback
  if (availableTabs.length === 0) {
    if (fallbackTips) {
      return (
        <div className="card p-4 mb-4 border border-white/5">
          <p className="text-sm text-gray-300 leading-relaxed">{fallbackTips}</p>
        </div>
      );
    }
    return null;
  }

  return (
    <section className="card p-4 sm:p-5 mb-4" aria-labelledby="theater-tips-heading">
      <h3 id="theater-tips-heading" className="text-base font-bold text-white mb-3">Theater Tips</h3>

      {/* Tab bar */}
      <div className="flex gap-1 mb-4 overflow-x-auto -mx-1 px-1" role="tablist" aria-label="Theater tips sections">
        {availableTabs.map(key => {
          const config = TAB_CONFIG[key];
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={isActive}
              aria-controls={`tips-panel-${key}`}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors border ${
                isActive
                  ? TAB_ACTIVE_CLASSES[key]
                  : 'text-gray-500 hover:text-gray-300 border-transparent'
              }`}
            >
              {config.icon}
              {config.label}
            </button>
          );
        })}
      </div>

      {/* Tab panels */}
      <div
        id={`tips-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'seating' && tips.seating && <SeatingTab seating={tips.seating} />}
        {activeTab === 'parking' && tips.parking && <ParkingTab parking={tips.parking} />}
        {activeTab === 'dining' && tips.dining && <DiningTab dining={tips.dining} />}
        {activeTab === 'logistics' && tips.logistics && <LogisticsTab logistics={tips.logistics} />}
      </div>
    </section>
  );
}
