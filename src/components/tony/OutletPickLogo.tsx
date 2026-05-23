'use client';

import { useState } from 'react';
import { getOutletLogoUrl, getOutletConfig } from '@/config/outlet-logos';

const CRITIC_PICK_OUTLETS: Record<string, { outletName: string; critic: string }> = {
  nyt:      { outletName: 'The New York Times', critic: 'Helen Shaw' },
  variety:  { outletName: 'Variety',            critic: 'Clayton Davis' },
};

export function OutletPickLogo({ outletId }: { outletId: string }) {
  const [imgError, setImgError] = useState(false);
  const meta = CRITIC_PICK_OUTLETS[outletId];
  if (!meta) return null;
  const logoUrl = getOutletLogoUrl(meta.outletName);
  const config = getOutletConfig(meta.outletName);
  const title = `${meta.outletName} (${meta.critic}) picks this show to win`;

  if (logoUrl && !imgError) {
    return (
      <div className="w-5 h-5 rounded-full bg-white flex items-center justify-center flex-shrink-0 overflow-hidden" title={title}>
        <img
          src={logoUrl}
          alt={meta.outletName}
          className="w-3.5 h-3.5 object-contain"
          onError={() => setImgError(true)}
        />
      </div>
    );
  }
  const abbrev = config?.abbrev || meta.outletName.charAt(0);
  const bgColor = config?.color || '#374151';
  const textSize = abbrev.length > 2 ? 'text-[7px]' : 'text-[9px]';
  return (
    <div
      className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${textSize} font-bold text-white leading-none`}
      style={{ backgroundColor: bgColor }}
      title={title}
    >
      {abbrev}
    </div>
  );
}

export function PressPicks({ picks }: { picks?: string[] }) {
  if (!picks || picks.length === 0) return null;
  const known = picks.filter(id => CRITIC_PICK_OUTLETS[id]);
  if (known.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5">
      {known.map(id => <OutletPickLogo key={id} outletId={id} />)}
    </div>
  );
}
