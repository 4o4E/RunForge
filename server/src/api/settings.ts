import { Router } from 'express';
import { getToolSettings, saveToolSettings } from '../settings.js';

export const settingsApi = Router();

settingsApi.get('/tools', async (_req, res) => {
  res.json(await getToolSettings());
});

settingsApi.put('/tools', async (req, res) => {
  try {
    res.json(await saveToolSettings(req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
