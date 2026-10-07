'use client';

import { useEffect, useState } from 'react';

interface CeremonyCountdownProps {
  ceremonyDate: string; // ISO date string: "2026-06-07"
}

function computeCountdown(ceremonyDateIso: string): { days: number; hours: number } | null {
  const now = new Date();
  const ceremony = new Date(`${ceremonyDateIso}T20:00:00-04:00`); // 8pm ET ceremony start
  const diffMs = ceremony.getTime() - now.getTime();
  if (diffMs <= 0) return null;
  const totalHours = diffMs / (1000 * 60 * 60);
  const days = Math.floor(totalHours / 24);
  const hours = Math.floor(totalHours % 24);
  return { days, hours };
}

export function CeremonyCountdown({ ceremonyDate }: CeremonyCountdownProps) {
  const [countdown, setCountdown] = useState<{ days: number; hours: number } | null>(null);

  useEffect(() => {
    const update = () => setCountdown(computeCountdown(ceremonyDate));
    update();
    const timer = setInterval(update, 60 * 1000);
    return () => clearInterval(timer);
  }, [ceremonyDate]);

  if (!countdown) return null;

  return (
    <p className="text-xs text-gray-500 mt-1">
      {countdown.days > 0
        ? `${countdown.days} day${countdown.days !== 1 ? 's' : ''} and ${countdown.hours} hour${countdown.hours !== 1 ? 's' : ''} until the ceremony`
        : `${countdown.hours} hour${countdown.hours !== 1 ? 's' : ''} until the ceremony`}
    </p>
  );
}
