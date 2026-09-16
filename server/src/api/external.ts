import { Router } from 'express';
import { RunActiveError, SpaceConfigChangedError } from '../store/types.js';
import { externalCommands } from '../external/service.js';
import { ExternalApiError } from '../external/types.js';

export const externalApi = Router();

export function sendExternalError(res: import('express').Response, error: unknown): void {
  if (error instanceof ExternalApiError) {
    res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
    return;
  }
  if (error instanceof RunActiveError) {
    res.status(409).json({
      error: error.message,
      code: error.code,
      currentRunId: error.currentRunId,
      currentStatus: error.currentStatus,
    });
    return;
  }
  if (error instanceof SpaceConfigChangedError) {
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: (error as Error).message, code: 'INTERNAL_ERROR' });
}

externalApi.post('/:uuidToken', async (req, res) => {
  try {
    const response = await externalCommands.execute(req.params.uuidToken, req.body);
    const operation = req.body?.operation;
    const status = operation === 'run.create' || operation === 'run.append'
      ? 202
      : operation === 'artifact.upload'
        ? 201
        : 200;
    res.status(status).json(response);
  } catch (error) {
    sendExternalError(res, error);
  }
});
