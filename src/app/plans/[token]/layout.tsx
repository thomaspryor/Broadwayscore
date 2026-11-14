import { privateShareMetadata } from '@/components/PrivateShareLayout';

// Private share shell: noindex + no-referrer on every state, links out load
// a new document (see src/components/PrivateShareLayout.tsx).
export const metadata = privateShareMetadata;
export { default } from '@/components/PrivateShareLayout';
