import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown';
import { useMemo } from 'react';
import { useThemeCtx } from '@/theme';

export const streamdownPlugins = { cjk, code, math, mermaid };
export const streamdownPreviewPlugins = { cjk, math, mermaid };
// 保留 raw/sanitize 等基础处理，但去掉 harden 的链接过滤，避免工作区相对文件链接被渲染成 [blocked]。
export const streamdownRehypePlugins = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== 'harden')
  .map(([, plugin]) => plugin) as NonNullable<StreamdownProps['rehypePlugins']>;

export function useThemedMermaid(): StreamdownProps['mermaid'] {
  const { theme } = useThemeCtx();

  return useMemo(
    () => ({
      config: {
        // 使用 Mermaid 内置主题，避免自定义灰蓝色板覆盖正常图表配色语义。
        theme: theme === 'dark' ? 'dark' : 'default',
      },
    }),
    [theme],
  );
}
