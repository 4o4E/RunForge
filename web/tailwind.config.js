const surface = (n) => `rgb(var(--surface-${n}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    // Streamdown styles its rendered output with Tailwind utilities; scan its
    // dist so those classes are emitted. Hoisted to the repo-root node_modules.
    '../node_modules/streamdown/dist/**/*.js',
  ],
  theme: {
    extend: {
      // Color language borrowed from the reference console (teal primary + surfaces).
      // `surface` stops are role-preserving CSS variables that flip in dark mode:
      // 50 = panel/card bg ... 950 = primary text, in BOTH themes.
      colors: {
        primary: {
          50: '#e9fbfb',
          100: '#ccf6f7',
          200: '#99ecef',
          300: '#5bdddf',
          400: '#23cbd0',
          500: '#00c2c7',
          600: '#009aa0',
          700: '#007b80',
          800: '#075f63',
          900: '#0b4f53',
        },
        surface: {
          50: surface(50),
          100: surface(100),
          200: surface(200),
          300: surface(300),
          400: surface(400),
          500: surface(500),
          600: surface(600),
          700: surface(700),
          800: surface(800),
          900: surface(900),
          950: surface(950),
        },
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        panel: '0 18px 42px rgba(21, 34, 48, 0.08)',
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.3s ease-out',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
