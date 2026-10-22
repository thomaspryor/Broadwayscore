import type { Config } from 'tailwindcss';

// Same token names as Broadway Scorecard's tailwind.config.ts, light values.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors: {
        score: {
          'must-see': '#FFD700',
          great: '#16a34a',
          good: '#0d9488',
          tepid: '#d97706',
          skip: '#dc2626',
          none: '#6b7280',
        },
        surface: {
          DEFAULT: '#ffffff',
          raised: '#ffffff',
          overlay: '#f5f5f7',
          elevated: '#ffffff',
        },
        ink: {
          DEFAULT: '#14141a',
          muted: '#5b5b66',
          faint: '#6b6b77',
        },
        line: {
          DEFAULT: '#e6e6ec',
          strong: '#d4d4dc',
        },
        brand: {
          DEFAULT: '#d4a574',
          hover: '#c4956a',
          ink: '#94632e',
          logo: '#b98048',
          muted: 'rgba(212, 165, 116, 0.18)',
        },
        status: {
          open: '#059669',
          'open-bg': 'rgba(16, 185, 129, 0.12)',
          new: '#7c3aed',
          'new-bg': 'rgba(124, 58, 237, 0.10)',
        },
      },
      borderRadius: {
        card: '1rem',
        badge: '0.625rem',
        pill: '9999px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(20, 20, 26, 0.04), 0 4px 16px rgba(20, 20, 26, 0.05)',
        'card-hover': '0 2px 4px rgba(20, 20, 26, 0.06), 0 10px 28px rgba(20, 20, 26, 0.09)',
      },
    },
  },
  plugins: [],
};
export default config;
