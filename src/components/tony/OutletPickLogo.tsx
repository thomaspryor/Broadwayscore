'use client';

import { useState } from 'react';
import { getOutletLogoUrl, getOutletConfig } from '@/config/outlet-logos';

const CRITIC_PICK_OUTLETS: Record<string, { outletName: string; critic: string }> = {
  nyt:          { outletName: 'The New York Times',    critic: 'Helen Shaw' },
  variety:      { outletName: 'Variety',               critic: 'Clayton Davis' },
  culturesauce: { outletName: 'Culture Sauce',         critic: 'Thom Geier' },
  nytg:         { outletName: 'New York Theatre Guide', critic: 'Mickey-Jo Theatre' },
  ew:           { outletName: 'Entertainment Weekly',  critic: 'Dalton Ross' },
  nysun:        { outletName: 'The New York Sun',      critic: 'Elysa Gardner' },
  theatermania: { outletName: 'TheaterMania',          critic: 'TheaterMania Staff' },
  slant:        { outletName: 'Slant Magazine',        critic: 'Dan Rubins' },
  timeout:      { outletName: 'Time Out New York',     critic: 'Adam Feldman' },
  thr:          { outletName: 'The Hollywood Reporter', critic: 'Ben Zauzmer' },
  deadline:     { outletName: 'Deadline',              critic: 'Greg Evans' },
  cityguide:    { outletName: 'City Guide New York',   critic: 'Griffin Miller' },
  vf:           { outletName: 'Vanity Fair',           critic: 'Little Gold Men' },
  elle:         { outletName: 'Elle',                  critic: 'Samuel Maude' },
  bg:           { outletName: 'Boston Globe',          critic: 'Christopher Wallenberg' },
  nytpaulson:   { outletName: 'The New York Times',    critic: 'Michael Paulson' },
  chitrib:      { outletName: 'Chicago Tribune',       critic: 'Chris Jones' },
  thewrap:      { outletName: 'The Wrap',              critic: 'Robert Hofler' },
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
