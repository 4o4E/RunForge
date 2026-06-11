import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import type { StreamdownProps } from 'streamdown';
import { useMemo } from 'react';
import { useThemeCtx } from '@/theme';

export const streamdownPlugins = { cjk, code, math, mermaid };

export function useThemedMermaid(): StreamdownProps['mermaid'] {
  const { theme } = useThemeCtx();

  return useMemo(
    () => ({
      config: {
        theme: 'base',
        themeVariables:
          theme === 'dark'
            ? {
                background: '#020817',
                primaryColor: '#12313f',
                primaryTextColor: '#e5f6f7',
                primaryBorderColor: '#38bdf8',
                secondaryColor: '#1e293b',
                secondaryTextColor: '#e2e8f0',
                secondaryBorderColor: '#64748b',
                tertiaryColor: '#172554',
                tertiaryTextColor: '#dbeafe',
                tertiaryBorderColor: '#60a5fa',
                mainBkg: '#0f172a',
                secondBkg: '#111827',
                lineColor: '#94a3b8',
                textColor: '#e2e8f0',
                nodeBorder: '#38bdf8',
                clusterBkg: '#0b1220',
                clusterBorder: '#334155',
                titleColor: '#f8fafc',
                edgeLabelBackground: '#020817',
                pie1: '#22d3ee',
                pie2: '#818cf8',
                pie3: '#fbbf24',
                pie4: '#34d399',
                pie5: '#fb7185',
                pie6: '#a78bfa',
                pie7: '#2dd4bf',
                pie8: '#f472b6',
                pie9: '#93c5fd',
                pie10: '#c4b5fd',
                pie11: '#fca5a5',
                pie12: '#bef264',
                pieOuterStrokeColor: '#475569',
                pieSectionTextColor: '#f8fafc',
                pieTitleTextSize: '18px',
              }
            : {
                background: '#ffffff',
                primaryColor: '#ecfeff',
                primaryTextColor: '#0f172a',
                primaryBorderColor: '#0891b2',
                secondaryColor: '#f8fafc',
                secondaryTextColor: '#0f172a',
                secondaryBorderColor: '#cbd5e1',
                tertiaryColor: '#eff6ff',
                tertiaryTextColor: '#172554',
                tertiaryBorderColor: '#60a5fa',
                lineColor: '#64748b',
                textColor: '#0f172a',
                mainBkg: '#f8fafc',
                secondBkg: '#f1f5f9',
                nodeBorder: '#0891b2',
                clusterBkg: '#f1f5f9',
                clusterBorder: '#cbd5e1',
                titleColor: '#0f172a',
                edgeLabelBackground: '#ffffff',
                pie1: '#0891b2',
                pie2: '#4f46e5',
                pie3: '#d97706',
                pie4: '#059669',
                pie5: '#e11d48',
                pie6: '#7c3aed',
                pie7: '#0d9488',
                pie8: '#db2777',
                pie9: '#2563eb',
                pie10: '#9333ea',
                pie11: '#dc2626',
                pie12: '#65a30d',
                pieOuterStrokeColor: '#cbd5e1',
                pieSectionTextColor: '#ffffff',
                pieTitleTextSize: '18px',
              },
      },
    }),
    [theme],
  );
}
