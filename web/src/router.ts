export interface ChatRoute {
  threadId: string | null;
  draft: string;
}

function decodePathValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function readChatRoute(loc: Location = window.location): ChatRoute {
  const pathValues = loc.pathname.split('/').filter(Boolean);
  const page = pathValues[0];
  const rawThreadId = pathValues[1];
  const search = new URLSearchParams(loc.search);
  const threadId = page === 'chat' && rawThreadId && rawThreadId !== 'new' ? decodePathValue(rawThreadId) : null;

  return {
    draft: search.get('draft') ?? '',
    threadId,
  };
}

export function buildChatPath(route: ChatRoute): string {
  const path = route.threadId ? `/chat/${encodeURIComponent(route.threadId)}` : '/chat/new';
  const search = new URLSearchParams();

  if (route.draft) {
    search.set('draft', route.draft);
  }

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function currentBrowserPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
