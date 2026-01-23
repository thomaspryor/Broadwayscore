import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    fontFamily: {
      sans: [
        'Inter',
        'ui-sans-serif',
        '-apple-system',
        'BlinkMacSystemFont',
        'Segoe UI',
        'Roboto',
        'Helvetica Neue',
        'Arial',
        'sans-serif',
      ],
    },
    extend: {
      colors: {
        // Score colors - keeping semantic colors for scores
        score: {
          high: '#10b981',
          'high-bg': 'rgba(16, 185, 129, 0.15)',
          medium: '#f59e0b',
          'medium-bg': 'rgba(245, 158, 11, 0.15)',
          low: '#ef4444',
          'low-bg': 'rgba(239, 68, 68, 0.15)',
          none: '#6b7280',
        },
        // Surface colors - deeper, richer darks
        surface: {
          DEFAULT: '#0f0f14',
          raised: '#1a1a24',
          overlay: '#2a2a38',
          elevated: '#32323f',
        },
        // Brand - Muted gold for prestigious feel
        brand: {
          DEFAULT: '#d4a574',
          hover: '#c4956a',
          light: '#e4b584',
          muted: 'rgba(212, 165, 116, 0.2)',
        },
        // Accent colors for variety
        accent: {
          gold: '#d4a574',
          cream: '#f5e6d3',
          purple: '#a855f7',
          warm: '#b8956a',
        },
        // Status colors
        status: {
          open: '#10b981',
          'open-bg': 'rgba(16, 185, 129, 0.2)',
          closed: '#6b7280',
          'closed-bg': 'rgba(107, 114, 128, 0.2)',
          previews: '#a855f7',
          'previews-bg': 'rgba(168, 85, 247, 0.2)',
        },
      },
      spacing: {
        'card': '1rem',
        'card-lg': '1.5rem',
        'section': '2rem',
      },
      borderRadius: {
        'card': '1rem',
        'badge': '0.625rem',
        'pill': '9999px',
      },
      fontSize: {
        'score-sm': ['0.875rem', { lineHeight: '1', fontWeight: '700' }],
        'score-md': ['1.125rem', { lineHeight: '1', fontWeight: '700' }],
        'score-lg': ['1.5rem', { lineHeight: '1', fontWeight: '700' }],
        'score-xl': ['2rem', { lineHeight: '1', fontWeight: '700' }],
      },
      boxShadow: {
        'card': '0 2px 8px -2px rgba(0, 0, 0, 0.5), 0 1px 2px -1px rgba(0, 0, 0, 0.4)',
        'card-hover': '0 8px 24px -4px rgba(0, 0, 0, 0.6), 0 4px 8px -2px rgba(0, 0, 0, 0.5)',
        'glow': '0 0 20px rgba(212, 165, 116, 0.3)',
        'glow-sm': '0 0 10px rgba(212, 165, 116, 0.2)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-brand': 'linear-gradient(135deg, #d4a574 0%, #b8956a 100%)',
        'gradient-dark': 'linear-gradient(180deg, #1a1a24 0%, #0f0f14 100%)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.8' },
        },
      },
    },
  },
  plugins: [],
}
export default config
