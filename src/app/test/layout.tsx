import type { Metadata } from 'next';
import { TestGuard } from './_components/TestGuard';

export const metadata: Metadata = {
  robots: 'noindex, nofollow',
};

export default function TestLayout({ children }: { children: React.ReactNode }) {
  return <TestGuard>{children}</TestGuard>;
}
