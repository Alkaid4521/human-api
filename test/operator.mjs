#!/usr/bin/env node
// Stands in for a human operator so that the code snippets in INTEGRATION.md can
// be verified without a person at the keyboard. Polls the admin queue and answers
// every pending request with a deterministic marker.
//
//   node test/operator.mjs
//
// OP_DELAY_MS=800   simulated typing time before answering
// OP_SKIP=1         ignore the first N requests (used to exercise the timeout path)
// OP_PREFIX='（人工回复）'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.HUMAN_BASE || 'http://127.0.0.1:8787';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const ADMIN = process.env.HUMAN_ADMIN || cfg.adminToken;

const DELAY_MS = Number(process.env.OP_DELAY_MS || 800);
const POLL_MS = Number(process.env.OP_POLL_MS || 250);
const SKIP = Number(process.env.OP_SKIP || 0);
const PREFIX = process.env.OP_PREFIX || '（人工回复）';

const headers = { Authorization: 'Bearer ' + ADMIN, 'Content-Type': 'application/json' };
const seen = new Set();
let skipped = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tick() {
  const res = await fetch(BASE + '/admin/api/state', { headers });
  if (!res.ok) throw new Error('state ' + res.status);
  const st = await res.json();
  for (const r of st.queue) {
    // The queue holds both pending and expired requests: an operator answers
    // whatever is in front of them, including calls whose client already gave up.
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    if (skipped < SKIP) {
      skipped++;
      console.log(`[op] ignoring ${r.id} (leaving it to time out)`);
      continue;
    }
    const q = (r.transcript.filter((m) => m.role === 'user').pop() || {}).content || '';
    const content = PREFIX + q.replace(/\s+/g, ' ').slice(0, 60);
    await sleep(DELAY_MS);
    const rep = await fetch(BASE + '/admin/api/reply', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: r.id, content }),
    });
    const j = await rep.json().catch(() => ({}));
    console.log(`[op] answered ${r.id} delivered=${j.delivered} waited=${j.waitedMs}ms -> ${JSON.stringify(content)}`);
  }
}

console.log(`[op] standing in for the human at ${BASE} (delay=${DELAY_MS}ms skip=${SKIP})`);
for (;;) {
  try {
    await tick();
  } catch (err) {
    console.error('[op]', err.message);
  }
  await sleep(POLL_MS);
}
