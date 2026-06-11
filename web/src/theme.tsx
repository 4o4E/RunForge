import { createContext, useContext, type ReactNode } from 'react';
import { useTheme, type Theme } from './useTheme';

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx>({ theme: 'light', toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, toggle] = useTheme();
  return <Ctx.Provider value={{ theme, toggle }}>{children}</Ctx.Provider>;
}

export const useThemeCtx = () => useContext(Ctx);
