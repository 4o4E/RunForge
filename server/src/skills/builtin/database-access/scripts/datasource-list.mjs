#!/usr/bin/env node
import { listDatasourceResources } from './dbCredential.mjs';

const catalog = await listDatasourceResources();
process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
