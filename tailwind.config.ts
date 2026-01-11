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
        'score-high': '#22c55e',
        'score-medium': '#eab308',
        'score-low': '#ef4444',
        'score-bg': '#1f2937',
      },
    },
  },
  plugins: [],
}
export default config
