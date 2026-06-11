// A2UI surface renderer: takes an A2uiMessage, indexes its components by id, and
// renders from `root` down — resolving `{ path }` bindings against the data model
// via the trusted shadcn catalog. Cyclic/missing refs degrade gracefully.

import { useMemo, type ReactNode } from 'react';
import { renderNode, type RenderCtx } from './catalog';
import type { A2uiComponent, A2uiMessage } from './types';

export function A2uiSurface({ message }: { message: A2uiMessage }) {
  const content = useMemo<ReactNode>(() => {
    if (!message || !Array.isArray(message.components)) return null;
    const byId = new Map<string, A2uiComponent>(message.components.map((c) => [c.id, c]));
    const seen = new Set<string>();

    const ctx: RenderCtx = {
      data: message.dataModel ?? {},
      byId,
      depth: 0,
      render: (id, depth) => {
        const node = byId.get(id);
        if (!node) return null;
        if (seen.has(id)) return null; // guard against cycles
        seen.add(id);
        const out = renderNode(node, { ...ctx, depth });
        seen.delete(id);
        return out;
      },
    };

    return ctx.render(message.root, 0);
  }, [message]);

  return <div className="a2ui-surface w-full space-y-2">{content}</div>;
}
