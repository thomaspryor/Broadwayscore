'use client';

/**
 * Client-side loader for the unreleased /box-office tables (BRO-5007). A
 * dynamic() call in the server page still bundles the module into the page
 * chunk; from a client module it becomes its own chunk, fetched only when
 * rendered (flags on). The build-time check drops the import, and with it the
 * chunk, from flag-off builds (see HELD_BOX_OFFICE_BUILD in next.config.js).
 */
import dynamic from 'next/dynamic';

const BoxOfficeV2TablesLazy = process.env.HELD_BOX_OFFICE_BUILD === 'true'
  ? dynamic(() => import('@/components/BoxOfficeV2Tables'))
  : () => null;

export default BoxOfficeV2TablesLazy;
