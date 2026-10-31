'use client';

/**
 * Client loader for the unreleased /box-office price map (BRO-5007 v3). From a
 * client module the map is its own chunk; the build-time check drops it from
 * flag-off builds (see HELD_BOX_OFFICE_BUILD in next.config.js).
 */
import dynamic from 'next/dynamic';

const PriceMapLazy = process.env.HELD_BOX_OFFICE_BUILD === 'true'
  ? dynamic(() => import('@/components/box-office/PriceMap'))
  : () => null;

export default PriceMapLazy;
