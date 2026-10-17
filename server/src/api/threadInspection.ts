import { Router } from 'express';
import { getIdentity } from '../auth/context.js';
import { inspectThread } from '../threads/inspection.js';
import { threadReadAccess, ThreadReadAccessError } from '../threads/readAccess.js';

export const threadInspectionApi = Router();

threadInspectionApi.get('/:id/inspection', async (req, res, next) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  const spaceId = typeof req.query.spaceId === 'string' && req.query.spaceId.trim() ? req.query.spaceId.trim() : undefined;
  try {
    const access = await threadReadAccess.resolve(identity, req.params.id, spaceId);
    res.json(await inspectThread(access));
  } catch (error) {
    if (error instanceof ThreadReadAccessError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  }
});
