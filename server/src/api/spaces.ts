import { Router, type Request, type Response } from 'express';
import { getIdentity, type IdentityContext } from '../auth/context.js';
import {
  parseCreateSpaceInput,
  parseUpdateSpaceInput,
  spaceAccess,
  SpaceAccessError,
  type SpaceActorContext,
} from '../spaces/access.js';
import { externalCallers } from '../external/callers.js';
import { ExternalApiError } from '../external/types.js';

export const tenantSpacesApi = Router();
export const systemSpacesApi = Router({ mergeParams: true });

type TenantIdentity = Extract<IdentityContext, { scope: 'tenant' }>;
type ResolveActor = (req: Request, res: Response) => SpaceActorContext | null;

export function sendSpaceError(res: Response, error: unknown): void {
  if (error instanceof ExternalApiError) {
    res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
    return;
  }
  if (error instanceof SpaceAccessError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: (error as Error).message });
}

const resolveTenantActor: ResolveActor = (_req, res) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return null;
  }
  return identity;
};

const resolveSystemActor: ResolveActor = (req) => ({
  scope: 'system',
  tenantId: (req.params as Record<string, string>).tenantId ?? '',
});

function includeDeleted(value: unknown): boolean {
  return value === '1' || value === 'true';
}

/** 身份入口保持分离，但 CRUD 的解析、错误契约和业务调用只维护一份。 */
function registerSpaceRoutes(router: Router, resolveActor: ResolveActor): void {
  router.get('/', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json({ spaces: await spaceAccess.list(actor, includeDeleted(req.query.includeDeleted)) });
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.get('/options', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.options(actor));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.get('/:spaceId/debug', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.debugView(actor, req.params.spaceId));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.get('/:spaceId/prompt-placeholders', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.promptPlaceholders(actor, req.params.spaceId));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.get('/:spaceId/debug/mcp/:mcpId', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.debugMcpSchema(actor, req.params.spaceId, req.params.mcpId));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.get('/:spaceId/callers', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json({ callers: await externalCallers.list(actor, req.params.spaceId) });
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.post('/:spaceId/callers', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.status(201).json(await externalCallers.create(actor, req.params.spaceId, req.body));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.patch('/:spaceId/callers/:callerId', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await externalCallers.update(actor, req.params.spaceId, req.params.callerId, req.body));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.post('/:spaceId/callers/:callerId/tokens', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.status(201).json(await externalCallers.issueToken(actor, req.params.spaceId, req.params.callerId, req.body));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.delete('/:spaceId/callers/:callerId/tokens/:tokenId', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await externalCallers.revokeToken(
        actor,
        req.params.spaceId,
        req.params.callerId,
        req.params.tokenId,
      ));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.get('/:spaceId', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.get(actor, req.params.spaceId));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.post('/', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.status(201).json(await spaceAccess.create(actor, parseCreateSpaceInput(req.body)));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.patch('/:spaceId', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.update(actor, req.params.spaceId, parseUpdateSpaceInput(req.body)));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.delete('/:spaceId', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.delete(actor, req.params.spaceId));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });

  router.post('/:spaceId/restore', async (req, res) => {
    const actor = resolveActor(req, res);
    if (!actor) return;
    try {
      res.json(await spaceAccess.restore(actor, req.params.spaceId));
    } catch (error) {
      sendSpaceError(res, error);
    }
  });
}

registerSpaceRoutes(tenantSpacesApi, resolveTenantActor);
registerSpaceRoutes(systemSpacesApi, resolveSystemActor);
