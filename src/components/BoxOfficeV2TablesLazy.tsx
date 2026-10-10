'use client';

/**
 * Client-side loader for the unreleased /box-office tables (BRO-5007). A
 * dynamic() call in the server page still bundles the module into the page
 * chunk; from a client module it becomes its own chunk, fetched only when
 * rendered (flags on).
 */
import dynamic from 'next/dynamic';

const BoxOfficeV2TablesLazy = dynamic(() => import('@/components/BoxOfficeV2Tables'));

export default BoxOfficeV2TablesLazy;
