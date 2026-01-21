import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Score colors
        score: {
          high: '#22c55e',
          'high-bg': 'rgba(34, 197, 94, 0.15)',
          medium: '#eab308',
          'medium-bg': 'rgba(234, 179, 8, 0.15)',
          low: '#ef4444',
          'low-bg': 'rgba(239, 68, 68, 0.15)',
          none: '#6b7280',
        },
        // Surface colors
        surface: {
          DEFAULT: '#111827',
          raised: '#1f2937',
          overlay: '#374151',
        },
        // Brand
        brand: {
          DEFAULT: '#22c55e',
          hover: '#16a34a',
          muted: 'rgba(34, 197, 94, 0.2)',
        },
        // Status colors
        status: {
          open: '#22c55e',
          'open-bg': 'rgba(34, 197, 94, 0.2)',
          closed: '#6b7280',
          'closed-bg': 'rgba(107, 114, 128, 0.2)',
          previews: '#a855f7',
          'previews-bg': 'rgba(168, 85, 247, 0.2)',
        },
      },
      spacing: {
        // Consistent spacing scale
        'card': '1rem',
        'card-lg': '1.5rem',
        'section': '2rem',
      },
      borderRadius: {
        'card': '0.75rem',
        'badge': '0.5rem',
      },
      fontSize: {
        'score-sm': ['0.875rem', { lineHeight: '1', fontWeight: '700' }],
        'score-md': ['1.125rem', { lineHeight: '1', fontWeight: '700' }],
        'score-lg': ['1.5rem', { lineHeight: '1', fontWeight: '700' }],
        'score-xl': ['2rem', { lineHeight: '1', fontWeight: '700' }],
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 1px 2px -1px rgba(0, 0, 0, 0.3)',
        'card-hover': '0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.4)',
      },
    },
  },
  plugins: [],
}
export default config
