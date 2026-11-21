import 'server-only';
import { readAdminMoneySignups } from '../../scripts/lib/admin-money-signups';

export interface MoneySignupDay {
  date: string;
  signups: { email: string; createdAt: string; role: string; firstPage: string }[];
}

export type AdminMoneySignups = { unavailable: true } | {
  total: number;
  last7Days: number;
  days: MoneySignupDay[];
};

// Only called after isAdmin() succeeds in the server page. Never cached.
export async function getAdminMoneySignups(): Promise<AdminMoneySignups> {
  const data = await readAdminMoneySignups({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  return 'unavailable' in data ? { unavailable: true } : data;
}
