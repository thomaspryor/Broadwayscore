// Outlet Logo Configuration
// Maps outlet names to their logo URLs and brand colors

export interface OutletLogoConfig {
  domain: string;       // For logo services (clearbit, google favicons)
  color?: string;       // Brand color for fallback circle
  abbrev?: string;      // Abbreviation for letter fallback
  darkBg?: boolean;     // If logo needs dark background
}

// Canonical outlet domain mappings
// Used with: https://logo.clearbit.com/{domain}
// Fallback: https://www.google.com/s2/favicons?domain={domain}&sz=64
export const OUTLET_LOGOS: Record<string, OutletLogoConfig> = {
  // Tier 1 - Major Publications
  'The New York Times': { domain: 'nytimes.com', color: '#000000', abbrev: 'T', darkBg: true },
  'New York Times': { domain: 'nytimes.com', color: '#000000', abbrev: 'T', darkBg: true },
  'NEW YORK TIMES': { domain: 'nytimes.com', color: '#000000', abbrev: 'T', darkBg: true },
  'NYT': { domain: 'nytimes.com', color: '#000000', abbrev: 'T', darkBg: true },

  'The Washington Post': { domain: 'washingtonpost.com', color: '#000000', abbrev: 'WP' },
  'Washington Post': { domain: 'washingtonpost.com', color: '#000000', abbrev: 'WP' },
  'WASHINGTON POST': { domain: 'washingtonpost.com', color: '#000000', abbrev: 'WP' },

  'The Wall Street Journal': { domain: 'wsj.com', color: '#000000', abbrev: 'WSJ' },
  'Wall Street Journal': { domain: 'wsj.com', color: '#000000', abbrev: 'WSJ' },
  'WSJ': { domain: 'wsj.com', color: '#000000', abbrev: 'WSJ' },

  'Variety': { domain: 'variety.com', color: '#be0028', abbrev: 'V' },
  'VARIETY': { domain: 'variety.com', color: '#be0028', abbrev: 'V' },

  'The Hollywood Reporter': { domain: 'hollywoodreporter.com', color: '#000000', abbrev: 'THR' },
  'Hollywood Reporter': { domain: 'hollywoodreporter.com', color: '#000000', abbrev: 'THR' },
  'HOLLYWOOD REPORTER': { domain: 'hollywoodreporter.com', color: '#000000', abbrev: 'THR' },

  'Vulture': { domain: 'vulture.com', color: '#f4511e', abbrev: 'V' },
  'VULTURE': { domain: 'vulture.com', color: '#f4511e', abbrev: 'V' },
  'New York Magazine / Vulture': { domain: 'vulture.com', color: '#f4511e', abbrev: 'V' },

  'New York Magazine': { domain: 'nymag.com', color: '#000000', abbrev: 'NYM' },
  'NY Magazine': { domain: 'nymag.com', color: '#000000', abbrev: 'NYM' },
  'NEW YORK MAGAZINE': { domain: 'nymag.com', color: '#000000', abbrev: 'NYM' },

  'The Guardian': { domain: 'theguardian.com', color: '#052962', abbrev: 'G' },
  'Guardian': { domain: 'theguardian.com', color: '#052962', abbrev: 'G' },

  'Time Out New York': { domain: 'timeout.com', color: '#e31b23', abbrev: 'TO' },
  'Time Out': { domain: 'timeout.com', color: '#e31b23', abbrev: 'TO' },
  'TimeOut New York': { domain: 'timeout.com', color: '#e31b23', abbrev: 'TO' },
  'TimeOut': { domain: 'timeout.com', color: '#e31b23', abbrev: 'TO' },
  'Timeout NY': { domain: 'timeout.com', color: '#e31b23', abbrev: 'TO' },
  'TIME OUT NEW YORK': { domain: 'timeout.com', color: '#e31b23', abbrev: 'TO' },

  'Associated Press': { domain: 'apnews.com', color: '#ff322e', abbrev: 'AP' },
  'AP': { domain: 'apnews.com', color: '#ff322e', abbrev: 'AP' },

  'Broadway News': { domain: 'broadwaynews.com', color: '#000000', abbrev: 'BN' },
  'BROADWAY NEWS': { domain: 'broadwaynews.com', color: '#000000', abbrev: 'BN' },

  // Tier 2 - Regional & Trade Publications
  'Entertainment Weekly': { domain: 'ew.com', color: '#e50914', abbrev: 'EW' },
  'EW': { domain: 'ew.com', color: '#e50914', abbrev: 'EW' },

  'New York Post': { domain: 'nypost.com', color: '#cf0a2c', abbrev: 'POST' },
  'NY Post': { domain: 'nypost.com', color: '#cf0a2c', abbrev: 'POST' },
  'NEW YORK POST': { domain: 'nypost.com', color: '#cf0a2c', abbrev: 'POST' },

  'New York Daily News': { domain: 'nydailynews.com', color: '#e31937', abbrev: 'DN' },
  'NY Daily News': { domain: 'nydailynews.com', color: '#e31937', abbrev: 'DN' },
  'The New York Daily News': { domain: 'nydailynews.com', color: '#e31937', abbrev: 'DN' },

  'Deadline': { domain: 'deadline.com', color: '#000000', abbrev: 'DL' },
  'DEADLINE': { domain: 'deadline.com', color: '#000000', abbrev: 'DL' },

  'IndieWire': { domain: 'indiewire.com', color: '#ff6b35', abbrev: 'IW' },

  'The Wrap': { domain: 'thewrap.com', color: '#1a1a1a', abbrev: 'TW' },
  'TheWrap': { domain: 'thewrap.com', color: '#1a1a1a', abbrev: 'TW' },
  'THE WRAP': { domain: 'thewrap.com', color: '#1a1a1a', abbrev: 'TW' },

  'The Daily Beast': { domain: 'thedailybeast.com', color: '#ff0000', abbrev: 'DB' },
  'Daily Beast': { domain: 'thedailybeast.com', color: '#ff0000', abbrev: 'DB' },
  'THE DAILY BEAST': { domain: 'thedailybeast.com', color: '#ff0000', abbrev: 'DB' },

  'Observer': { domain: 'observer.com', color: '#ff5722', abbrev: 'OBS' },
  'The Observer': { domain: 'observer.com', color: '#ff5722', abbrev: 'OBS' },

  'USA Today': { domain: 'usatoday.com', color: '#009bff', abbrev: 'USA' },
  'Usa Today': { domain: 'usatoday.com', color: '#009bff', abbrev: 'USA' },

  'Chicago Tribune': { domain: 'chicagotribune.com', color: '#00549f', abbrev: 'CT' },
  'CHICAGO TRIBUNE': { domain: 'chicagotribune.com', color: '#00549f', abbrev: 'CT' },

  'Los Angeles Times': { domain: 'latimes.com', color: '#000000', abbrev: 'LAT' },
  'LA Times': { domain: 'latimes.com', color: '#000000', abbrev: 'LAT' },
  'La Times': { domain: 'latimes.com', color: '#000000', abbrev: 'LAT' },
  'The LA Times': { domain: 'latimes.com', color: '#000000', abbrev: 'LAT' },

  'Slant Magazine': { domain: 'slantmagazine.com', color: '#ff6b6b', abbrev: 'S' },
  'Slant': { domain: 'slantmagazine.com', color: '#ff6b6b', abbrev: 'S' },

  'TheaterMania': { domain: 'theatermania.com', color: '#7c3aed', abbrev: 'TM' },
  'Theatermania': { domain: 'theatermania.com', color: '#7c3aed', abbrev: 'TM' },
  'THEATERMANIA': { domain: 'theatermania.com', color: '#7c3aed', abbrev: 'TM' },

  'Theatrely': { domain: 'theatrely.com', color: '#ec4899', abbrev: 'TH' },
  'THEATRELY': { domain: 'theatrely.com', color: '#ec4899', abbrev: 'TH' },

  'New York Theater': { domain: 'newyorktheater.me', color: '#6366f1', abbrev: 'NYT' },
  'New York Theatre Guide': { domain: 'newyorktheatreguide.com', color: '#000000', abbrev: 'NYTG' },
  'NY Stage Review': { domain: 'nystagereview.com', color: '#4f46e5', abbrev: 'NYSR' },
  'New York Stage Review': { domain: 'nystagereview.com', color: '#4f46e5', abbrev: 'NYSR' },

  // Tier 3 - Smaller Outlets
  'BroadwayWorld': { domain: 'broadwayworld.com', color: '#d4af37', abbrev: 'BWW' },
  'Broadway World': { domain: 'broadwayworld.com', color: '#d4af37', abbrev: 'BWW' },

  'amNewYork': { domain: 'amny.com', color: '#0066cc', abbrev: 'AM' },
  'AM New York': { domain: 'amny.com', color: '#0066cc', abbrev: 'AM' },
  'AM NEW YORK': { domain: 'amny.com', color: '#0066cc', abbrev: 'AM' },

  'Cititour': { domain: 'cititour.com', color: '#10b981', abbrev: 'CT' },

  'Culture Sauce': { domain: 'culturesauce.com', color: '#f59e0b', abbrev: 'CS' },

  'Front Mezz Junkies': { domain: 'frontmezzjunkies.com', color: '#8b5cf6', abbrev: 'FMJ' },

  "Talkin' Broadway": { domain: 'talkinbroadway.com', color: '#3b82f6', abbrev: 'TB' },
  'Talkin Broadway': { domain: 'talkinbroadway.com', color: '#3b82f6', abbrev: 'TB' },

  'Theater Pizzazz': { domain: 'theaterpizzazz.com', color: '#ef4444', abbrev: 'TP' },

  'The New Yorker': { domain: 'newyorker.com', color: '#000000', abbrev: 'TNY' },

  'Rolling Stone': { domain: 'rollingstone.com', color: '#ff0000', abbrev: 'RS' },

  'Vanity Fair': { domain: 'vanityfair.com', color: '#000000', abbrev: 'VF' },

  'People': { domain: 'people.com', color: '#e60012', abbrev: 'P' },

  'Billboard': { domain: 'billboard.com', color: '#000000', abbrev: 'BB' },

  'NBC New York': { domain: 'nbcnewyork.com', color: '#0089d0', abbrev: 'NBC' },

  'Newsday': { domain: 'newsday.com', color: '#004990', abbrev: 'ND' },

  'NJ.com': { domain: 'nj.com', color: '#004c97', abbrev: 'NJ' },
  'NJ.com / Star-Ledger': { domain: 'nj.com', color: '#004c97', abbrev: 'NJ' },

  'Vox': { domain: 'vox.com', color: '#f9be00', abbrev: 'VOX' },

  'Slate': { domain: 'slate.com', color: '#262626', abbrev: 'SL' },

  'HuffPost': { domain: 'huffpost.com', color: '#0dbe3e', abbrev: 'HP' },

  'The Stage': { domain: 'thestage.co.uk', color: '#000080', abbrev: 'TS' },
  'The Stage (UK)': { domain: 'thestage.co.uk', color: '#000080', abbrev: 'TS' },

  'WhatsOnStage': { domain: 'whatsonstage.com', color: '#0066cc', abbrev: 'WOS' },

  'Evening Standard': { domain: 'standard.co.uk', color: '#000000', abbrev: 'ES' },
  'The Standard': { domain: 'standard.co.uk', color: '#000000', abbrev: 'ES' },

  'The Telegraph': { domain: 'telegraph.co.uk', color: '#006847', abbrev: 'TEL' },

  'The Independent': { domain: 'independent.co.uk', color: '#ec1a2e', abbrev: 'IND' },

  'Financial Times (UK)': { domain: 'ft.com', color: '#fff1e5', abbrev: 'FT', darkBg: false },
  'The Financial Times': { domain: 'ft.com', color: '#fff1e5', abbrev: 'FT', darkBg: false },

  'Boston Globe': { domain: 'bostonglobe.com', color: '#000000', abbrev: 'BG' },

  'The Philadelphia Inquirer': { domain: 'inquirer.com', color: '#0066cc', abbrev: 'PI' },

  'Toronto Star': { domain: 'thestar.com', color: '#d50000', abbrev: 'TS' },

  'The Globe and Mail': { domain: 'theglobeandmail.com', color: '#000000', abbrev: 'GM' },

  'BBC News': { domain: 'bbc.com', color: '#bb1919', abbrev: 'BBC' },

  'TIME': { domain: 'time.com', color: '#e90606', abbrev: 'TIME' },

  'Backstage': { domain: 'backstage.com', color: '#ff4444', abbrev: 'BS' },

  'Mashable': { domain: 'mashable.com', color: '#0066ff', abbrev: 'M' },

  'Parade': { domain: 'parade.com', color: '#e31837', abbrev: 'PAR' },

  'Village Voice': { domain: 'villagevoice.com', color: '#ff0000', abbrev: 'VV' },
  'The Village Voice': { domain: 'villagevoice.com', color: '#ff0000', abbrev: 'VV' },

  'Bloomberg': { domain: 'bloomberg.com', color: '#000000', abbrev: 'BL' },

  'National Review': { domain: 'nationalreview.com', color: '#004b87', abbrev: 'NR' },

  'America Magazine': { domain: 'americamagazine.org', color: '#b71c1c', abbrev: 'AM' },

  'Forward': { domain: 'forward.com', color: '#0066cc', abbrev: 'FWD' },
  'The Forward': { domain: 'forward.com', color: '#0066cc', abbrev: 'FWD' },

  // Smaller/Niche Sites
  'Pages on Stages': { domain: 'pagesonstages.com', color: '#9333ea', abbrev: 'POS' },
  'Theater Life': { domain: 'theaterlife.com', color: '#14b8a6', abbrev: 'TL' },
  'Theatre is Easy': { domain: 'theatreiseasy.com', color: '#22c55e', abbrev: 'TIE' },
  'One Minute Critic': { domain: 'oneminutecritic.com', color: '#f97316', abbrev: '1MC' },
  'One-Minute Critic': { domain: 'oneminutecritic.com', color: '#f97316', abbrev: '1MC' },
  '1 Minute Critic': { domain: 'oneminutecritic.com', color: '#f97316', abbrev: '1MC' },
  'Stage and Cinema': { domain: 'stageandcinema.com', color: '#6366f1', abbrev: 'S&C' },
  'CurtainUp': { domain: 'curtainup.com', color: '#dc2626', abbrev: 'CU' },
  'Theatre Reviews Limited': { domain: 'theatrereviewslimited.com', color: '#7c3aed', abbrev: 'TRL' },
  'Exeunt': { domain: 'exeuntmagazine.com', color: '#000000', abbrev: 'EX' },
  'Exeunt Magazine': { domain: 'exeuntmagazine.com', color: '#000000', abbrev: 'EX' },
  'Lighting & Sound America': { domain: 'lightingandsoundamerica.com', color: '#1e40af', abbrev: 'LSA' },
  'The Recs': { domain: 'therecs.com', color: '#059669', abbrev: 'REC' },
  'Broadway Blog': { domain: 'broadwayblog.com', color: '#d97706', abbrev: 'BBL' },
  'Broadway & Me': { domain: 'broadwayandme.com', color: '#be185d', abbrev: 'B&M' },
  'Broadway Voice': { domain: 'broadwayvoice.com', color: '#7c2d12', abbrev: 'BV' },
  'TheaterScene.net': { domain: 'theaterscene.net', color: '#4338ca', abbrev: 'TSN' },
  'TheaterScene.com': { domain: 'theaterscene.com', color: '#4338ca', abbrev: 'TSC' },
  'Front Row Center': { domain: 'frontrowcenter.com', color: '#be123c', abbrev: 'FRC' },
};

// Get logo URL for an outlet
export function getOutletLogoUrl(outlet: string): string | null {
  const config = OUTLET_LOGOS[outlet];
  if (!config) return null;

  // Use Google Favicons (Clearbit Logo API was shut down after HubSpot acquisition)
  return `https://www.google.com/s2/favicons?domain=${config.domain}&sz=64`;
}

// Get fallback favicon URL
export function getOutletFaviconUrl(outlet: string): string | null {
  const config = OUTLET_LOGOS[outlet];
  if (!config) return null;

  return `https://www.google.com/s2/favicons?domain=${config.domain}&sz=64`;
}

// Get outlet config (for fallback styling)
export function getOutletConfig(outlet: string): OutletLogoConfig | null {
  return OUTLET_LOGOS[outlet] || null;
}
