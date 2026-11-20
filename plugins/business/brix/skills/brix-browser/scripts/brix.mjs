#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './cli.mjs';
import { BrixClient, BrixError } from './client.mjs';

await main(process.argv.slice(2), async () => {
  const sdkPath = process.env.RUNFORGE_WORKLOAD_SDK;
  if (!sdkPath) throw new BrixError('missing_workload_sdk');
  const { RunForgeWorkloadClient } = await import(pathToFileURL(sdkPath).href);
  const workload = new RunForgeWorkloadClient();
  const baseUrl = await workload.secrets.get('brix.base-url');
  const token = await workload.secrets.get('brix.token');
  return new BrixClient(baseUrl, token);
});
