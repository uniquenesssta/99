export function indexListWorkerSource(): string {
  return String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');

const FONT_EXTENSIONS = new Set(workerData.extensions || []);
const folders = Array.isArray(workerData.folders) ? workerData.folders : [];
const files = [];
const errors = [];
let foldersScanned = 0;
let lastProgressAt = 0;
let pendingBatch = [];
let batchStep = 0;
const BATCH_SIZES = [10, 50, 100, 200];

function nextBatchSize() {
  return BATCH_SIZES[Math.min(batchStep, BATCH_SIZES.length - 1)];
}

function sendProgress(force, batch) {
  const now = Date.now();
  if (!force && !batch && now - lastProgressAt < 300) return;
  lastProgressAt = now;
  parentPort.postMessage({ type: 'progress', files: files.length, foldersScanned, batch });
}

function enqueueBatch(row) {
  pendingBatch.push(row);
  if (pendingBatch.length < nextBatchSize()) return;
  const batch = pendingBatch;
  pendingBatch = [];
  batchStep += 1;
  sendProgress(true, batch);
}

function flushBatch() {
  if (!pendingBatch.length) return;
  const batch = pendingBatch;
  pendingBatch = [];
  batchStep += 1;
  sendProgress(true, batch);
}

function walk(rootPath, dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
    foldersScanned += 1;
    sendProgress(false);
  } catch (error) {
    errors.push({ path: dir, message: error instanceof Error ? error.message : String(error) });
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(rootPath, full);
      } else if (entry.isFile() && FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        if (entry.name.startsWith('._')) continue;
        const stat = fs.statSync(full);
        const row = {
          file: full,
          rootPath,
          stat: {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            birthtimeMs: stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs,
            ctimeMs: stat.ctimeMs || stat.mtimeMs
          }
        };
        files.push(row);
        enqueueBatch(row);
        sendProgress(false);
      }
    } catch (error) {
      errors.push({ path: full, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

for (const folder of folders) {
  try {
    const stat = fs.statSync(folder);
    if (!stat.isDirectory()) continue;
    walk(folder, folder);
  } catch (error) {
    errors.push({ path: folder, message: error instanceof Error ? error.message : String(error) });
  }
}

flushBatch();
sendProgress(true);
parentPort.postMessage({ type: 'done', files, errors, foldersScanned });
`;
}


