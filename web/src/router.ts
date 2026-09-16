export interface ChatRoute {
  spaceId: string | null;
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
  const rawSpaceId = pathValues[0];
  const rawThreadId = pathValues[1];
  const search = new URLSearchParams(loc.search);
  const spaceId = rawSpaceId?.startsWith('sp_') ? decodePathValue(rawSpaceId) : null;
  const threadId = (spaceId || rawSpaceId === 'chat') && rawThreadId?.startsWith('th_')
    ? decodePathValue(rawThreadId)
    : null;

  return {
    draft: search.get('draft') ?? '',
    spaceId,
    threadId,
  };
}

export function buildChatPath(route: ChatRoute): string {
  const path = route.spaceId
    ? `/${encodeURIComponent(route.spaceId)}${route.threadId ? `/${encodeURIComponent(route.threadId)}` : ''}`
    : '/';
  const search = new URLSearchParams();

  if (route.draft) {
    search.set('draft', route.draft);
  }

  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function buildSearchPath(spaceId: string | null, query = ''): string {
  const search = new URLSearchParams({ view: 'search' });
  if (query.trim()) search.set('q', query.trim());
  const base = spaceId ? `/${encodeURIComponent(spaceId)}` : '/';
  return `${base}?${search.toString()}`;
}

export function currentBrowserPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}
