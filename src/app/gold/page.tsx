'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function GoldRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/lists'); }, [router]);
  return (
    <meta httpEquiv="refresh" content="0;url=/lists" />
  );
}
