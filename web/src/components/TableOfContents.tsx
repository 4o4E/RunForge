import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { cn } from '@/lib/utils';

interface TocItem {
  index: number;
  text: string;
  time?: string;
}

const MESSAGE_SELECTOR = '[data-toc-message]';

/** 找到真实滚动对话内容的最近父容器。 */
function getScrollParent(node: HTMLElement | null): HTMLElement | null {
  let el = node?.parentElement ?? null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

function scrollInsideContainer(container: HTMLElement, target: HTMLElement) {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const nextTop = container.scrollTop + targetRect.top - containerRect.top - 12;
  container.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
}

function computeActiveIndex(root: HTMLElement, targets: HTMLElement[]): number | null {
  const scrollParent = getScrollParent(root);
  const viewport = scrollParent?.getBoundingClientRect() ?? root.getBoundingClientRect();
  const visible = targets
    .map((target, index) => ({ index, rect: target.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom);

  if (visible.length > 0) {
    visible.sort((a, b) => Math.max(a.rect.top, viewport.top) - Math.max(b.rect.top, viewport.top));
    return visible[0].index;
  }

  let nearestPast: number | null = null;
  for (const { index, rect } of targets.map((target, index) => ({ index, rect: target.getBoundingClientRect() }))) {
    if (rect.top <= viewport.top) nearestPast = index;
  }
  return nearestPast ?? (targets.length > 0 ? 0 : null);
}

function hasTocMessageNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;
  return node.matches(MESSAGE_SELECTOR) || !!node.querySelector(MESSAGE_SELECTOR);
}

function sameItems(a: TocItem[], b: TocItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const next = b[index];
    return item.index === next.index && item.text === next.text && item.time === next.time;
  });
}

function shouldCollectTargets(records: MutationRecord[]): boolean {
  return records.some((record) => (
    Array.from(record.addedNodes).some(hasTocMessageNode)
    || Array.from(record.removedNodes).some(hasTocMessageNode)
  ));
}

/**
 * 对话大纲只认用户消息，默认用树状横条展示消息分布。
 * 悬浮时隐藏横条，改为展示可点击的消息列表卡片。
 */
export function TableOfContents({
  contentRef,
  floating = true,
}: {
  contentRef: RefObject<HTMLElement | null>;
  floating?: boolean;
}) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const targetsRef = useRef<HTMLElement[]>([]);
  const itemsRef = useRef<TocItem[]>([]);

  const collectTargets = useCallback((root: HTMLElement) => {
    const targets: HTMLElement[] = [];
    const nextItems: TocItem[] = [];

    for (const message of Array.from(root.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR))) {
      const role = message.dataset.tocMessage;
      if (role !== 'user') continue;
      const text = message.dataset.tocTitle || '对话';
      nextItems.push({ index: targets.length, text, time: message.dataset.tocTime });
      targets.push(message);
    }

    return { items: nextItems, targets };
  }, []);

  // 只在顶层消息列表变化时重建大纲，流式输出内部节点变化不参与扫描。
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    let activeFrame = 0;
    let collectFrame = 0;
    const applyActive = () => {
      setActiveIndex((previous) => {
        const next = computeActiveIndex(root, targetsRef.current);
        return previous === next ? previous : next;
      });
    };
    const collect = () => {
      const collected = collectTargets(root);
      targetsRef.current = collected.targets;
      if (!sameItems(itemsRef.current, collected.items)) {
        itemsRef.current = collected.items;
        setItems(collected.items);
      }
      applyActive();
    };
    const scheduleActive = () => {
      if (activeFrame) return;
      activeFrame = window.requestAnimationFrame(() => {
        activeFrame = 0;
        applyActive();
      });
    };
    const scheduleCollect = () => {
      if (collectFrame) return;
      collectFrame = window.requestAnimationFrame(() => {
        collectFrame = 0;
        collect();
      });
    };
    const scrollParent = getScrollParent(root);
    collect();
    const mo = new MutationObserver((records) => {
      if (shouldCollectTargets(records)) scheduleCollect();
    });
    mo.observe(root, {
      childList: true,
    });
    scrollParent?.addEventListener('scroll', scheduleActive, { passive: true });
    window.addEventListener('resize', scheduleActive);
    return () => {
      if (activeFrame) window.cancelAnimationFrame(activeFrame);
      if (collectFrame) window.cancelAnimationFrame(collectFrame);
      mo.disconnect();
      scrollParent?.removeEventListener('scroll', scheduleActive);
      window.removeEventListener('resize', scheduleActive);
    };
  }, [collectTargets, contentRef]);

  const handleClick = useCallback(
    (index: number) => {
      const root = contentRef.current;
      if (!root) return;
      const el = collectTargets(root).targets[index];
      if (el) {
        const scrollParent = getScrollParent(root);
        if (scrollParent) scrollInsideContainer(scrollParent, el);
        setActiveIndex(index);
      }
    },
    [collectTargets, contentRef],
  );

  if (items.length === 0) return null;

  return (
    <nav
      className={cn(
        'group pointer-events-auto min-h-0 w-72',
        floating && 'absolute right-6 top-64 z-20 hidden 2xl:block',
      )}
      aria-label="对话大纲"
    >
      <div className="flex w-full flex-col items-end gap-2 rounded-md py-2 transition-opacity group-hover:pointer-events-none group-hover:hidden">
        <div
          className={cn(
            'scrollbar-thin flex flex-col items-end gap-2 overflow-hidden',
            floating ? 'max-h-[min(11rem,calc(100vh-18rem))]' : 'max-h-[min(11rem,calc(100vh-22rem))]',
          )}
        >
          {items.map((item) => (
            <button
              key={item.index}
              type="button"
              onClick={() => handleClick(item.index)}
              title={item.time ? `${item.time}\n${item.text}` : item.text}
              className={cn(
                'h-1 w-9 rounded-full transition-all hover:bg-white',
                activeIndex === item.index ? 'bg-white shadow-[0_0_0_1px_hsl(var(--background)/0.45)]' : 'bg-white/45',
              )}
              aria-label={item.text}
            />
          ))}
        </div>
      </div>
      <div className="pointer-events-none hidden w-72 max-w-[calc(100vw-3rem)] overflow-hidden rounded-md border bg-card p-2.5 text-card-foreground shadow-lg group-hover:block group-hover:pointer-events-auto">
        <div className="mb-1 px-2 text-[10px] text-muted-foreground">用户消息</div>
        <div
          className={cn(
            'scrollbar-thin overflow-auto',
            floating ? 'max-h-[min(22rem,calc(100vh-20rem))]' : 'max-h-[min(22rem,calc(100vh-24rem))]',
          )}
        >
          {items.map((item) => (
            <button
              key={item.index}
              type="button"
              onClick={() => handleClick(item.index)}
              className={cn(
                'block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground',
                activeIndex === item.index && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="block truncate text-[11px] tabular-nums text-muted-foreground">{item.time || '无时间'}</span>
              <span className="mt-0.5 block truncate leading-4">{item.text}</span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
