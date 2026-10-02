// Sends ONE real request and records the outcome to logs/live-request-result.json.
// Used for a hand-driven live test: the request waits in the queue until a person
// answers it from the phone admin page.
//
//   node test/live-request.mjs
//
// LIVE_TIMEOUT_MS  how long the server should hold the request (default 30 min)
// HUMAN_BASE       defaults to the local server
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.HUMAN_BASE || 'http://127.0.0.1:8787';
const KEY =
  process.env.HUMAN_KEY ||
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8')).apiKeys[0];
const OUT = path.join(ROOT, 'logs', 'live-request-result.json');
const TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 1_800_000);

const QUESTION =
  process.env.LIVE_QUESTION ||
  '通了没有？如果你是在手机上看到这条消息、并且亲手回了它，那就说明整条链路是活的：' +
    '公网请求 → 排队 → 手机通知 → 你打字 → 原路返回给调用方。随便回点什么吧。';

const started = Date.now();
const record = (obj) => fs.writeFileSync(OUT, JSON.stringify({ started, ...obj }, null, 2));
record({ state: 'sending', base: BASE, timeoutMs: TIMEOUT_MS });
console.log(`[live] sending to ${BASE} (waits up to ${TIMEOUT_MS / 1000}s)`);
console.log(`[live] result will be written to ${OUT}`);

try {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'human',
      timeout_ms: TIMEOUT_MS,
      messages: [
        { role: 'system', content: '你正在扮演一个真人。对面的请求来自一个 OpenAI 兼容接口。' },
        { role: 'user', content: QUESTION },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  const elapsedMs = Date.now() - started;
  record({ state: 'done', status: res.status, elapsedMs, data });
  console.log(`[live] HTTP ${res.status} after ${elapsedMs} ms`);
  console.log(JSON.stringify(data, null, 2));
} catch (err) {
  record({ state: 'error', error: String(err.message), elapsedMs: Date.now() - started });
  console.log('[live] error:', err.message);
}
