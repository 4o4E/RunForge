import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, chown, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { sanitizeMediaPayloads } from '../llm/observability/mediaPayload.js';

const traceFilePattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

async function sanitizeFile(path: string): Promise<boolean> {
  const original = await stat(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporaryPath, { flags: 'wx' });
  let changed = false;
  try {
    const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      const serialized = line ? JSON.stringify(sanitizeMediaPayloads(JSON.parse(line))) : line;
      if (serialized !== line) changed = true;
      if (!output.write(`${serialized}\n`)) await once(output, 'drain');
    }
    output.end();
    await finished(output);
    if (!changed) {
      await rm(temporaryPath);
      return false;
    }
    const temporary = await stat(temporaryPath);
    if (temporary.uid !== original.uid || temporary.gid !== original.gid) {
      await chown(temporaryPath, original.uid, original.gid);
    }
    await chmod(temporaryPath, original.mode);
    await rename(temporaryPath, path);
    return true;
  } catch (error) {
    output.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

await mkdir(config.trace.directory, { recursive: true });
const runDirectories = (await readdir(config.trace.directory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory());
const files = (await Promise.all(runDirectories.map(async (runDirectory) => {
  const directory = join(config.trace.directory, runDirectory.name);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && traceFilePattern.test(basename(entry.name)))
    .map((entry) => join(directory, entry.name));
}))).flat();
let changedCount = 0;
for (const file of files) {
  if (await sanitizeFile(file)) changedCount += 1;
}
console.log(`已检查 ${files.length} 个 run trace 文件，更新 ${changedCount} 个文件。`);
