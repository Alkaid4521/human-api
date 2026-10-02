#!/usr/bin/env node
// End-to-end test: exercises the OpenAI surface while a script plays the human
// operator on the admin API. Requires a running server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const KEY = process.env.KEY || cfg.apiKeys[0];
const ADMIN = process.env.ADMIN || cfg.adminToken;

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

const api = (p, init = {}) =>
  fetch(BASE + p, {
    ...init,
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const admin = (p, init = {}) =>
  fetch(BASE + p, {
    ...init,
    headers: { Authorization: 'Bearer ' + ADMIN, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPending(index = 0, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await (await admin('/admin/api/state')).json();
    if (st.queue[index]) return st.queue[index];
    await sleep(120);
  }
  throw new Error('request never showed up in the admin queue');
}

async function reply(id, content) {
  const res = await admin('/admin/api/reply', { method: 'POST', body: JSON.stringify({ id, content }) });
  if (!res.ok) throw new Error('reply failed: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

function parseSSE(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6);
    out.push(payload === '[DONE]' ? { done: true } : JSON.parse(payload));
  }
  return out;
}

async function main() {
  console.log(`\nHuman-as-API · e2e against ${BASE}\n`);
  // A hung test used to sit silently for minutes; fail loudly instead.
  const guard = setTimeout(() => {
    console.error('\ntest exceeded 90s — a request was never woken up. Aborting.');
    process.exit(2);
  }, 90000);
  guard.unref?.();

  // 1 ── models
  console.log('[1] /v1/models');
  const models = await (await api('/v1/models')).json();
  check('returns a model list', models.object === 'list' && models.data.length > 0, JSON.stringify(models).slice(0, 120));
  check('the model is literally a human', models.data[0].owned_by === 'human');

  // 2 ── auth
  console.log('[2] auth');
  const noAuth = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'human', messages: [{ role: 'user', content: 'hi' }] }),
  });
  check('no key → 401', noAuth.status === 401);
  const badAuth = await api('/v1/models', { headers: { Authorization: 'Bearer sk-wrong' } });
  check('wrong key → 401', badAuth.status === 401);

  // 3 ── non-stream round trip
  console.log('[3] non-stream chat round trip');
  const t3 = Date.now();
  const pendingReq = api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'human',
      messages: [
        { role: 'system', content: '你是一个人类。' },
        { role: 'user', content: '你好，请问你是谁？' },
      ],
    }),
  });
  const q3 = await waitForPending(0);
  check('request landed in the admin queue', q3.transcript.length === 2, JSON.stringify(q3.transcript));
  check('system/user roles preserved', q3.transcript[0].role === 'system' && q3.transcript[1].role === 'user');
  const ANSWER3 = '我是本人，手动打字的回复。';
  const rep3 = await reply(q3.id, ANSWER3);
  check('answer reached the live client (no lost-wakeup race)', rep3.delivered === true, JSON.stringify(rep3));
  const r3 = await pendingReq;
  const b3 = await r3.json();
  check('HTTP 200', r3.status === 200, String(r3.status));
  check('content equals the human answer', b3.choices[0].message.content === ANSWER3, JSON.stringify(b3).slice(0, 200));
  check('assistant role + stop finish_reason', b3.choices[0].message.role === 'assistant' && b3.choices[0].finish_reason === 'stop');
  check('id looks like chatcmpl-*', /^chatcmpl-/.test(b3.id), b3.id);
  check('usage is reported', b3.usage.total_tokens > 0, JSON.stringify(b3.usage));
  check('waited_ms is tracked', typeof b3.x_human?.waited_ms === 'number' && Date.now() - t3 > 0);

  // 4 ── streaming round trip
  console.log('[4] streaming round trip');
  const streamReq = api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'human', stream: true, messages: [{ role: 'user', content: '流式测试' }] }),
  });
  const q4 = await waitForPending(0);
  const ANSWER4 = '这是流式返回的手打内容。';
  await sleep(300);
  const rep4 = await reply(q4.id, ANSWER4);
  check('streaming client was woken mid-stream', rep4.delivered === true, JSON.stringify(rep4));
  const r4 = await streamReq;
  check('SSE content-type', (r4.headers.get('content-type') || '').includes('text/event-stream'), r4.headers.get('content-type'));
  const chunks = parseSSE(await r4.text());
  check('first chunk carries the assistant role', chunks[0]?.choices?.[0]?.delta?.role === 'assistant');
  check('a content delta equals the answer', chunks.some((c) => c.choices?.[0]?.delta?.content === ANSWER4), JSON.stringify(chunks).slice(0, 240));
  check('terminates with finish_reason=stop', chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'));
  check('terminates with [DONE]', chunks.at(-1)?.done === true);
  const joined = chunks.map((c) => c.choices?.[0]?.delta?.content || '').join('');
  check('concatenated deltas == answer', joined === ANSWER4, JSON.stringify(joined));

  // 5 ── timeout keeps the request answerable
  console.log('[5] timeout path');
  const t5 = await api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'human', timeout_ms: 1200, messages: [{ role: 'user', content: '超时测试' }] }),
  });
  const b5 = await t5.json();
  check('timeout status is 408 (survives proxies; 5xx bodies get replaced)', t5.status === 408, String(t5.status));
  check('error code is human_timeout', b5.error?.code === 'human_timeout', JSON.stringify(b5).slice(0, 160));
  const lateId = /id=([\w-]+)/.exec(b5.error.message)?.[1];
  check('late-answer id is advertised', Boolean(lateId), b5.error?.message);
  const st5 = await (await admin('/admin/api/state')).json();
  check('request stays in the queue after timeout', st5.queue.some((r) => r.id === lateId && r.status === 'expired'));

  // 6 ── late answer is retrievable
  console.log('[6] late answer retrieval');
  const ANSWER6 = '迟到的回复。';
  const rep6 = await reply(lateId, ANSWER6);
  check('late reply reports delivered=false (client already gone)', rep6.delivered === false, JSON.stringify(rep6));
  const got = await (await api('/v1/human/requests/' + lateId)).json();
  check('GET /v1/human/requests/<id> returns the answer', got.status === 'answered' && got.answer === ANSWER6, JSON.stringify(got).slice(0, 200));
  check('late fetch exposes choices', got.choices[0].message.content === ANSWER6);

  // 7 ── legacy completions
  console.log('[7] /v1/completions');
  const legacyReq = api('/v1/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'human', prompt: '写一句结尾' }),
  });
  const q7 = await waitForPending(0);
  const rep7 = await reply(q7.id, '结尾。');
  check('legacy client was woken', rep7.delivered === true);
  const b7 = await (await legacyReq).json();
  check('legacy text_completion shape', b7.object === 'text_completion' && b7.choices[0].text === '结尾。', JSON.stringify(b7).slice(0, 160));

  // 8 ── cancel
  console.log('[8] operator cancel');
  const cancelReq = api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'human', messages: [{ role: 'user', content: '取消测试' }] }),
  });
  const q8 = await waitForPending(0);
  await admin('/admin/api/cancel', { method: 'POST', body: JSON.stringify({ id: q8.id }) });
  const r8 = await cancelReq;
  const b8 = await r8.json();
  check('499 on cancel', r8.status === 499, String(r8.status));
  check('code is human_cancelled', b8.error?.code === 'human_cancelled');

  // 9 ── validation
  console.log('[9] input validation');
  const bad = await api('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'human' }) });
  check('missing messages → 400', bad.status === 400);
  const badJson = await api('/v1/chat/completions', { method: 'POST', body: '{oops' });
  check('broken JSON → 400', badJson.status === 400);
  const health = await (await fetch(BASE + '/healthz')).json();
  check('healthz ok', health.ok === true, JSON.stringify(health));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\ntest crashed:', err.message);
  process.exit(1);
});
