import Link from 'next/link';

type DiscountPage = 'all' | 'lotteries' | 'rush' | 'standing-room' | 'best-value';

const tabs: { id: DiscountPage; label: string; shortLabel: string; href: string }[] = [
  { id: 'all', label: 'All Discounts', shortLabel: 'All', href: '/discount-tickets' },
  { id: 'lotteries', label: 'Lotteries', shortLabel: 'Lottery', href: '/lotteries' },
  { id: 'rush', label: 'Rush', shortLabel: 'Rush', href: '/rush' },
  { id: 'standing-room', label: 'Standing Room', shortLabel: 'SRO', href: '/standing-room' },
  { id: 'best-value', label: 'Best Value', shortLabel: 'Value', href: '/best-value' },
];

interface DiscountTicketsNavProps {
  active: DiscountPage;
}

export function DiscountTicketsNav({ active }: DiscountTicketsNavProps) {
  return (
    <nav className="flex gap-1 overflow-x-auto scrollbar-hide mb-6 -mx-4 px-4 sm:mx-0 sm:px-0" aria-label="Discount ticket categories">
      {tabs.map(tab => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            className={`whitespace-nowrap px-3 py-2 rounded-lg text-sm font-medium transition-colors shrink-0 ${
              isActive
                ? 'bg-brand/15 text-brand border border-brand/30'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }`}
            aria-current={isActive ? 'page' : undefined}
          >
            <span className="hidden sm:inline">{tab.label}</span>
            <span className="sm:hidden">{tab.shortLabel}</span>
          </Link>
        );
      })}
    </nav>
  );
}
