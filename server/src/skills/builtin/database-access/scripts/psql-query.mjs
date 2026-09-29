#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { getDatasourceCredential } from './dbCredential.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const inlineSql = option('--sql');
const sqlFile = option('--file');
if (Boolean(inlineSql) === Boolean(sqlFile)) {
  throw new Error('必须且只能提供 --sql 或 --file');
}

const sql = inlineSql ?? await readFile(sqlFile, 'utf8');
const credential = await getDatasourceCredential();
const connection = credential.connection ?? {};
const command = option('--psql') ?? process.env.PSQL_BIN ?? 'psql';
const args = [
  '-h', String(credential.host ?? connection.host),
  '-p', String(credential.port ?? connection.port ?? 5432),
  '-U', credential.username,
  '-d', String(credential.database ?? connection.database),
  '-v', 'ON_ERROR_STOP=1',
  '-c', sql,
];

const child = spawn(command, args, {
  env: { ...process.env, PGPASSWORD: credential.password },
  stdio: 'inherit',
});
child.once('error', (error) => {
  throw error;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
