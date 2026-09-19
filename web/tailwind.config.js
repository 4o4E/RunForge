import tailwindcssAnimate from 'tailwindcss-animate';

const surface = (n) => `rgb(var(--surface-${n}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    '../node_modules/@rjsf/shadcn/src/**/*.{js,ts,jsx,tsx}',
    // Streamdown 的渲染结果会带 Tailwind 类名，这里扫描包产物确保样式被生成。
    '../node_modules/streamdown/dist/**/*.js',
  ],
  theme: {
    extend: {
      // 黑白灰主题：surface 是角色化色阶，暗色模式下会整体翻转。
      // 50 表示面板背景，950 表示主要文本，两个主题里语义保持一致。
      colors: {
        // shadcn 语义 token 来自 index.css，通用组件只依赖这些角色色。
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        primary: {
          // 保留 primary 色阶的兼容写法，但色值全部改为中性色，不再引入青色品牌色。
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          50: '#fafafa',
          100: '#f5f5f5',
          200: '#e5e5e5',
          300: '#d4d4d4',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#262626',
          900: '#171717',
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
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.3s ease-out',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
      keyframes: {
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
