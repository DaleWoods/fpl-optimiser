#!/usr/bin/env node
/**
 * tsc only emits JavaScript. The migration runner reads .sql files from disk at runtime, so
 * they have to be copied into the build output or a deployed instance starts with no schema.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const assets = [['src/db/migrations', 'dist/db/migrations']];

for (const [from, to] of assets) {
  const source = resolve(root, from);
  const target = resolve(root, to);
  if (!existsSync(source)) {
    console.error(`copy-assets: missing source ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log(`copy-assets: ${from} -> ${to}`);
}
