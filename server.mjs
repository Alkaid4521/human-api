#!/usr/bin/env node
// Human-as-API: an OpenAI-compatible endpoint whose model is a real person.
// Zero dependencies. Node 20+ (uses global fetch).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.HUMAN_DATA_DIR || path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Mirror console output into a log file. On Windows a redirected stdout is
// block-buffered, so a hung or killed process can leave the console file empty.
const LOG_FILE = process.env.HUMAN_LOG_FILE || path.join(ROOT, 'logs', 'server.log');
if (LOG_FILE) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const append = (level, args) => {
    try {
      fs.appendFileSync(
        LOG_FILE,
        `${new Date().toISOString()} [${level}] ` +
          args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') +
          '\n',
      );
    } catch {
      /* logging must never break the server */
    }
  };
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { origLog(...a); append('info', a); };
  console.error = (...a) => { origErr(...a); append('err', a); };
}

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const LOG_PATH = path.join(DATA_DIR, 'requests.jsonl');
const MAX_LOG_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- config

const DEFAULT_QUICK_REPLIES = [
  '收到，我看一下再回你。',
  '稍等，我去查一下资料。',
  '现在不方便，晚点回复你。',
];

function randomToken(n = 24) {
  return crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
}

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    cfg = {};
  }
  let dirty = false;
  if (!cfg.adminToken) {
    cfg.adminToken = randomToken(32);
    dirty = true;
  }
  if (!Array.isArray(cfg.apiKeys) || cfg.apiKeys.length === 0) {
    cfg.apiKeys = ['sk-human-' + randomToken(32)];
    dirty = true;
  }
  if (!cfg.notify || typeof cfg.notify !== 'object') {
    // A private, unguessable ntfy topic so the phone gets pinged out of the box.
    cfg.notify = { provider: 'ntfy', topic: 'human-api-' + randomToken(16), webhook: '', enabled: true };
    dirty = true;
  }
  if (!cfg.timeoutMs) cfg.timeoutMs = 300000;
  if (!Array.isArray(cfg.quickReplies) || cfg.quickReplies.length === 0) {
    cfg.quickReplies = DEFAULT_QUICK_REPLIES.slice();
    dirty = true;
  }
  if (!cfg.modelAliases) {
    cfg.modelAliases = ['human', 'human-1', 'me'];
    dirty = true;
  }
  if (dirty) saveConfig(cfg);
  return cfg;
}

function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

const config = loadConfig();

const PORT = Number(process.env.PORT || config.port || 8787);
const HOST = process.env.HOST || config.host || '0.0.0.0';
const PUBLIC_URL = (process.env.HUMAN_PUBLIC_URL || config.publicUrl || '').replace(/\/+$/, '');

// Status returned when nobody answers in time. Deliberately NOT 504: Cloudflare
// (and several other reverse proxies, including quick tunnels) replaces a 5xx
// origin body with its own HTML error page, which breaks OpenAI clients that
// expect a JSON error object. 408 is the conventional long-poll timeout and
// passes through untouched.
const TIMEOUT_STATUS = Number(process.env.HUMAN_TIMEOUT_STATUS || config.timeoutStatus || 408);

if (process.env.HUMAN_ADMIN_TOKEN) config.adminToken = process.env.HUMAN_ADMIN_TOKEN;
if (process.env.HUMAN_API_KEYS) {
  config.apiKeys = process.env.HUMAN_API_KEYS.split(',').map((s) => s.trim()).filter(Boolean);
}
if (process.env.HUMAN_NTFY_TOPIC) {
  config.notify = { ...config.notify, provider: 'ntfy', topic: process.env.HUMAN_NTFY_TOPIC };
}
if (process.env.HUMAN_NTFY_SERVER) config.notifyServer = process.env.HUMAN_NTFY_SERVER;
if (process.env.HUMAN_WEBHOOK) {
  config.notify = { ...config.notify, provider: 'webhook', webhook: process.env.HUMAN_WEBHOOK };
}
if (process.env.HUMAN_TIMEOUT_MS) config.timeoutMs = Number(process.env.HUMAN_TIMEOUT_MS);
if (process.env.HUMAN_NOTIFY_DISABLED === '1') config.notify = { ...config.notify, enabled: false };
const NTFY_SERVER = (process.env.HUMAN_NTFY_SERVER || config.notifyServer || 'https://ntfy.sh').replace(/\/+$/, '');

const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_BODY = 1024 * 1024;
const KEEP = 400; // requests kept in memory

// ---------------------------------------------------------------- store

/** @type {Map<string, object>} */
const requests = new Map();
/** @type {Map<string, {resolve: Function, timer: any, kind: 'chat'|'text'}>} */
const waiters = new Map();
/** @type {Set<import('node:http').ServerResponse>} */
const adminStreams = new Set();

function loadLog() {
  if (!fs.existsSync(LOG_PATH)) return;
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.id) requests.set(r.id, r);
    } catch {
      /* ignore a torn line */
    }
  }
  if (requests.size > KEEP) {
    const ids = [...requests.values()].sort((a, b) => a.created - b.created).map((r) => r.id);
    for (const id of ids.slice(0, requests.size - KEEP)) requests.delete(id);
  }
  console.log(`[store] replayed ${requests.size} request(s) from ${LOG_PATH}`);
}

function persist(r) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.' + Date.now() + '.bak');
    }
    fs.appendFileSync(LOG_PATH, JSON.stringify(r) + '\n');
  } catch (err) {
    console.error('[store] persist failed:', err.message);
  }
}

function touch(r, patch = {}) {
  Object.assign(r, patch, { updated: Date.now() });
  persist(r);
  broadcast({ type: 'update', id: r.id, status: r.status });
  return r;
}

function listRequests() {
  return [...requests.values()].sort((a, b) => b.created - a.created);
}

// ---------------------------------------------------------------- admin live feed

function broadcast(evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of adminStreams) {
    try {
      res.write(payload);
    } catch {
      adminStreams.delete(res);
    }
  }
}

// ---------------------------------------------------------------- notify

function notifyTitle(r) {
  const tag = r.transcript?.find((m) => m.role === 'user')?.content || r.promptPreview || '(空消息)';
  return '新请求 · ' + tag.replace(/\s+/g, ' ').slice(0, 60);
}

function notifyBody(r) {
  const lines = [];
  lines.push(r.transcript?.map((m) => `[${m.role}] ${m.content}`).join('\n\n') || '');
  lines.push('');
  lines.push(`模型: ${r.model} | 来自: ${r.meta?.ip || '?'} | 等待上限: ${Math.round(r.timeoutMs / 1000)}s`);
  return lines.join('\n').slice(0, 3500);
}

async function pushNotify(r) {
  if (!config.notify?.enabled) return;
  const adminUrl = PUBLIC_URL ? `${PUBLIC_URL}/admin?req=${encodeURIComponent(r.id)}` : '';
  try {
    if (config.notify.provider === 'ntfy' && config.notify.topic) {
      const headers = {
        Title: encodeURIComponent(notifyTitle(r)).replace(/%20/g, ' '),
        Priority: 'high',
        Tags: 'incoming_envelope,writing_hand',
      };
      if (adminUrl) headers.Click = adminUrl;
      const res = await fetch(`${NTFY_SERVER}/${encodeURIComponent(config.notify.topic)}`, {
        method: 'POST',
        headers,
        body: notifyBody(r),
      });
      if (!res.ok) throw new Error(`ntfy ${res.status} ${await res.text().catch(() => '')}`);
      console.log(`[notify] pushed to ${NTFY_SERVER}/${config.notify.topic}`);
    } else if (config.notify.provider === 'webhook' && config.notify.webhook) {
      const res = await fetch(config.notify.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: notifyTitle(r), body: notifyBody(r), url: adminUrl, id: r.id }),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
    }
  } catch (err) {
    console.error('[notify] failed:', err.message);
    touch(r, { notifyError: String(err.message).slice(0, 200) });
  }
}

// ---------------------------------------------------------------- http helpers

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, opts = {}) {
  sendJson(res, status, {
    error: {
      message,
      type: opts.type || 'invalid_request_error',
      code: opts.code || null,
      param: opts.param || null,
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON body');
  }
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function bearer(req, url) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m) return m[1].trim();
  return url.searchParams.get('token') || url.searchParams.get('api_key') || '';
}

function isAdmin(req, url) {
  const t = bearer(req, url);
  return Boolean(t) && timingSafeEqual(t, config.adminToken);
}

function isApi(req, url) {
  const t = bearer(req, url);
  if (!t) return false;
  return config.apiKeys.some((k) => timingSafeEqual(t, k));
}

// crude per-IP limiter: protects a publicly exposed admin token from brute force
const buckets = new Map();
function rateLimit(ip, key, limit, windowMs) {
  const k = key + '|' + ip;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(k, b);
  }
  b.count++;
  if (buckets.size > 5000) buckets.clear();
  return b.count <= limit;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

// ---------------------------------------------------------------- transcript

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'image_url') return '[图片] ' + (part.image_url?.url || '').slice(0, 120);
        if (part?.type === 'input_text') return part.text || '';
        return `[${part?.type || 'part'}]`;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

function buildTranscript(messages) {
  return (messages || []).map((m) => ({
    role: m?.role || 'user',
    content: flattenContent(m?.content),
  }));
}

// ---------------------------------------------------------------- request lifecycle

function newId() {
  return 'human-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function resolveWaiter(id, outcome) {
  const w = waiters.get(id);
  if (!w) return false;
  waiters.delete(id);
  clearTimeout(w.timer);
  w.resolve(outcome);
  return true;
}

function watchClientGone(r, res) {
  res.on('close', () => {
    if (r.status === 'pending' && !r.clientGone) {
      r.clientGone = true;
      persist(r);
      broadcast({ type: 'update', id: r.id, status: r.status });
      console.log(`[queue] ~ ${r.id} client disconnected, request stays answerable`);
    }
  });
}

async function enqueue(r) {
  requests.set(r.id, r);
  persist(r);
  broadcast({ type: 'new', id: r.id });
  console.log(`[queue] + ${r.id} model=${r.model} ip=${r.meta.ip} len=${r.promptPreview.length}`);

  // The waiter is registered synchronously, before the first await. An operator
  // can answer within milliseconds (the queue is already visible in the admin
  // UI), and an answer that lands while the push notification is still in
  // flight would otherwise be stored without ever waking the waiting client.
  const waiting = new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(r.id);
      resolve({ type: 'timeout' });
    }, r.timeoutMs);
    waiters.set(r.id, { resolve, timer });
  });
  if (r.status === 'answered') resolveWaiter(r.id, { type: 'answered', content: r.answer, request: r });

  const all = listRequests();
  if (all.length > KEEP) {
    for (const old of all.slice(KEEP)) {
      if (old.status !== 'pending') requests.delete(old.id);
    }
  }

  pushNotify(r).catch((err) => console.error('[notify] failed:', err.message));

  const outcome = await waiting;
  if (outcome.type === 'answered') return { ok: true, content: outcome.content, request: outcome.request };
  if (outcome.type === 'cancelled') return { ok: false, reason: 'cancelled' };
  return { ok: false, reason: 'timeout' };
}

// ---------------------------------------------------------------- openai shapes

function estimateUsage(r, content) {
  const p = Math.max(1, Math.ceil((r.promptChars || 0) / 3));
  const c = Math.max(1, Math.ceil((content || '').length / 3));
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

function chatCompletion(r, content, finishReason = 'stop') {
  return {
    id: 'chatcmpl-' + r.id,
    object: 'chat.completion',
    created: Math.floor(r.created / 1000),
    model: r.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: estimateUsage(r, content),
    system_fingerprint: 'human-v1',
    'x_human': { request_id: r.id, waited_ms: (r.answeredAt || Date.now()) - r.created },
  };
}

function textCompletion(r, content, finishReason = 'stop') {
  return {
    id: 'cmpl-' + r.id,
    object: 'text_completion',
    created: Math.floor(r.created / 1000),
    model: r.model,
    choices: [{ index: 0, text: content, logprobs: null, finish_reason: finishReason }],
    usage: estimateUsage(r, content),
  };
}

// ---------------------------------------------------------------- routes: openai

function modelList() {
  return {
    object: 'list',
    data: config.modelAliases.map((id) => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'human',
    })),
  };
}

async function handleChat(req, res, url) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendError(res, 400, 'you must provide a "messages" array', { param: 'messages' });
  }

  const transcript = buildTranscript(messages);
  const lastUser = [...transcript].reverse().find((m) => m.role === 'user');
  const timeoutMs = clampTimeout(body.timeout_ms ?? body.human_timeout_ms ?? config.timeoutMs);
  const stream = body.stream === true;

  const r = {
    id: newId(),
    kind: 'chat',
    model: body.model || 'human',
    created: Date.now(),
    status: 'pending',
    stream,
    transcript,
    promptPreview: (lastUser?.content || '').slice(0, 400),
    promptChars: transcript.reduce((n, m) => n + m.content.length, 0),
    timeoutMs,
    answer: null,
    answeredAt: null,
    meta: {
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
      forward: req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).slice(0, 200) : '',
    },
  };

  r.usageRequested = body.stream_options?.include_usage === true;
  watchClientGone(r, res);
  if (stream) return streamChat(req, res, r);

  const outcome = await enqueue(r);
  if (outcome.ok) {
    return sendJson(res, 200, chatCompletion(r, outcome.content));
  }
  if (outcome.reason === 'cancelled') {
    return sendError(res, 499, 'request cancelled by operator', { code: 'human_cancelled' });
  }
  touch(r, { status: 'expired', expiredAt: Date.now() });
  return sendError(
    res,
    TIMEOUT_STATUS,
    `the human did not answer within ${Math.round(r.timeoutMs / 1000)}s. ` +
      `The request is still queued (id=${r.id}); poll GET /v1/human/requests/${r.id} to collect a late answer.`,
    { type: 'api_error', code: 'human_timeout' },
  );
}

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return config.timeoutMs;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(n)));
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function streamChat(req, res, r) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const base = {
    id: 'chatcmpl-' + r.id,
    object: 'chat.completion.chunk',
    created: Math.floor(r.created / 1000),
    model: r.model,
    system_fingerprint: 'human-v1',
  };
  sseWrite(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });

  // Keep the socket warm while the human types: SSE comments are ignored by clients
  // but still count as traffic for read timeouts.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* closed */
    }
  }, 10000);

  let closed = false;
  res.on('close', () => {
    closed = true;
    clearInterval(keepAlive);
  });

  const outcome = await enqueue(r);
  clearInterval(keepAlive);
  if (closed) return;

  if (!outcome.ok) {
    const isTimeout = outcome.reason === 'timeout';
    if (isTimeout) touch(r, { status: 'expired', expiredAt: Date.now() });
    const msg = isTimeout
      ? `the human did not answer within ${Math.round(r.timeoutMs / 1000)}s (id=${r.id}, still queued)`
      : 'request cancelled by operator';
    sseWrite(res, { error: { message: msg, type: 'api_error', code: isTimeout ? 'human_timeout' : 'human_cancelled' } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  sseWrite(res, { ...base, choices: [{ index: 0, delta: { content: outcome.content }, finish_reason: null }] });
  sseWrite(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  if (r.usageRequested) {
    sseWrite(res, { ...base, choices: [], usage: estimateUsage(r, outcome.content) });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleTextCompletion(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const promptRaw = Array.isArray(body.prompt) ? body.prompt.join('\n') : body.prompt;
  if (typeof promptRaw !== 'string' || !promptRaw.trim()) {
    return sendError(res, 400, 'you must provide a "prompt" string', { param: 'prompt' });
  }
  const r = {
    id: newId(),
    kind: 'text',
    model: body.model || 'human',
    created: Date.now(),
    status: 'pending',
    stream: false,
    transcript: [{ role: 'user', content: promptRaw }],
    promptPreview: promptRaw.slice(0, 400),
    promptChars: promptRaw.length,
    timeoutMs: clampTimeout(body.timeout_ms ?? config.timeoutMs),
    answer: null,
    answeredAt: null,
    meta: { ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200), forward: '' },
  };
  watchClientGone(r, res);
  const outcome = await enqueue(r);
  if (outcome.ok) return sendJson(res, 200, textCompletion(r, outcome.content));
  if (outcome.reason === 'cancelled') return sendError(res, 499, 'request cancelled by operator', { code: 'human_cancelled' });
  touch(r, { status: 'expired', expiredAt: Date.now() });
  return sendError(res, TIMEOUT_STATUS, `the human did not answer within ${Math.round(r.timeoutMs / 1000)}s (id=${r.id})`, {
    type: 'api_error',
    code: 'human_timeout',
  });
}

function handleGetRequest(res, id) {
  const r = requests.get(id);
  if (!r) return sendError(res, 404, 'no such request: ' + id, { code: 'not_found' });
  const answered = r.status === 'answered';
  return sendJson(res, 200, {
    id: r.id,
    status: r.status,
    created: r.created,
    answered_at: r.answeredAt,
    waited_ms: r.answeredAt ? r.answeredAt - r.created : null,
    model: r.model,
    messages: r.transcript,
    choices: answered
      ? [{ index: 0, message: { role: 'assistant', content: r.answer }, finish_reason: 'stop' }]
      : [],
    answer: r.answer,
  });
}

// ---------------------------------------------------------------- routes: admin

function adminState() {
  const all = listRequests();
  const queue = all.filter((r) => r.status === 'pending' || r.status === 'expired');
  const done = all.filter((r) => r.status === 'answered' || r.status === 'cancelled').slice(0, 40);
  const strip = (r) => ({
    id: r.id,
    kind: r.kind,
    model: r.model,
    status: r.status,
    created: r.created,
    answeredAt: r.answeredAt,
    waitedMs: r.answeredAt ? r.answeredAt - r.created : null,
    timeoutMs: r.timeoutMs,
    transcript: r.transcript,
    answer: r.answer,
    meta: r.meta,
    notifyError: r.notifyError || null,
  });
  const answered = all.filter((r) => r.status === 'answered' && r.answeredAt);
  const avg = answered.length
    ? Math.round(answered.slice(0, 50).reduce((n, r) => n + (r.answeredAt - r.created), 0) / Math.min(answered.length, 50))
    : null;
  return {
    queue: queue.map(strip),
    done: done.map(strip),
    stats: {
      pending: queue.filter((r) => r.status === 'pending').length,
      expired: queue.filter((r) => r.status === 'expired').length,
      answered: answered.length,
      avgWaitMs: avg,
    },
    config: {
      timeoutMs: config.timeoutMs,
      quickReplies: config.quickReplies,
      notify: { provider: config.notify?.provider, topic: config.notify?.topic, enabled: config.notify?.enabled },
      modelAliases: config.modelAliases,
      apiKeys: config.apiKeys.map((k) => k.slice(0, 12) + '…' + k.slice(-4)),
    },
    publicUrl: PUBLIC_URL || `http://<本机IP>:${PORT}`,
  };
}

function serveAdminHtml(res) {
  const file = path.join(PUBLIC_DIR, 'admin.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('admin.html missing: ' + err.message);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function handleAdminEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
  adminStreams.add(res);
  const hb = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch {
      /* closed */
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(hb);
    adminStreams.delete(res);
  });
}

async function handleAdminReply(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const id = String(body.id || '');
  const content = typeof body.content === 'string' ? body.content : '';
  const r = requests.get(id);
  if (!r) return sendError(res, 404, 'no such request: ' + id);
  if (r.status === 'answered') return sendError(res, 409, 'already answered');
  if (!content.trim()) return sendError(res, 400, 'content is empty');

  const answeredAt = Date.now();
  touch(r, { status: 'answered', answer: content, answeredAt });
  const delivered = resolveWaiter(id, { type: 'answered', content, request: r });
  console.log(`[queue] ✓ ${id} answered in ${answeredAt - r.created}ms (live=${delivered})`);
  return sendJson(res, 200, { ok: true, id, delivered, waitedMs: answeredAt - r.created });
}

async function handleAdminCancel(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const r = requests.get(String(body.id || ''));
  if (!r) return sendError(res, 404, 'no such request');
  touch(r, { status: 'cancelled', answeredAt: Date.now() });
  resolveWaiter(r.id, { type: 'cancelled' });
  return sendJson(res, 200, { ok: true });
}

async function handleAdminConfig(req, res) {
  const body = await readJson(req).catch(() => ({}));
  if (body.timeoutMs != null) config.timeoutMs = clampTimeout(body.timeoutMs);
  if (Array.isArray(body.quickReplies)) config.quickReplies = body.quickReplies.map(String).slice(0, 30);
  if (body.notify && typeof body.notify === 'object') {
    config.notify = {
      provider: ['ntfy', 'webhook', 'none'].includes(body.notify.provider) ? body.notify.provider : config.notify.provider,
      topic: typeof body.notify.topic === 'string' ? body.notify.topic.trim() : config.notify.topic,
      webhook: typeof body.notify.webhook === 'string' ? body.notify.webhook.trim() : config.notify.webhook,
      enabled: body.notify.enabled !== false,
    };
  }
  if (typeof body.publicUrl === 'string') config.publicUrl = body.publicUrl.trim();
  saveConfig(config);
  broadcast({ type: 'config' });
  return sendJson(res, 200, { ok: true, config: adminState().config });
}

async function handleAdminTestNotify(req, res) {
  const fake = {
    id: 'test',
    model: 'human',
    created: Date.now(),
    timeoutMs: config.timeoutMs,
    promptPreview: '这是一条测试通知，说明你的手机能收到新请求提醒。',
    transcript: [{ role: 'user', content: '这是一条测试通知，说明你的手机能收到新请求提醒。' }],
    meta: { ip: 'test' },
  };
  try {
    await pushNotify(fake);
    return sendJson(res, 200, { ok: true, message: '已发送测试通知' });
  } catch (err) {
    return sendError(res, 500, err.message);
  }
}

function handleAdminRotate(req, res, url) {
  const which = url.searchParams.get('what') || 'api';
  if (which === 'admin') {
    config.adminToken = randomToken(32);
    saveConfig(config);
    return sendJson(res, 200, { ok: true, adminToken: config.adminToken });
  }
  config.apiKeys = ['sk-human-' + randomToken(32)];
  saveConfig(config);
  return sendJson(res, 200, { ok: true, apiKeys: config.apiKeys });
}

// ---------------------------------------------------------------- main handler

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const ip = clientIp(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  try {
    if (p === '/healthz') {
      const all = listRequests();
      return sendJson(res, 200, {
        ok: true,
        pending: all.filter((r) => r.status === 'pending').length,
        answered: all.filter((r) => r.status === 'answered').length,
        uptime_s: Math.round(process.uptime()),
      });
    }

    // ---- OpenAI-compatible surface
    if (p === '/v1/models' || p === '/models') {
      if (!isApi(req, url)) return sendError(res, 401, 'missing or invalid API key', { code: 'invalid_api_key' });
      return sendJson(res, 200, modelList());
    }
    if (p === '/v1/chat/completions' || p === '/chat/completions') {
      if (!isApi(req, url)) return sendError(res, 401, 'missing or invalid API key', { code: 'invalid_api_key' });
      if (!rateLimit(ip, 'chat', 120, 60000)) return sendError(res, 429, 'rate limit exceeded', { code: 'rate_limited' });
      return await handleChat(req, res, url);
    }
    if (p === '/v1/completions' || p === '/completions') {
      if (!isApi(req, url)) return sendError(res, 401, 'missing or invalid API key', { code: 'invalid_api_key' });
      if (!rateLimit(ip, 'cmpl', 120, 60000)) return sendError(res, 429, 'rate limit exceeded', { code: 'rate_limited' });
      return await handleTextCompletion(req, res);
    }
    const mReq = /^\/v1\/human\/requests\/([\w-]+)$/.exec(p);
    if (mReq) {
      if (!isApi(req, url)) return sendError(res, 401, 'missing or invalid API key', { code: 'invalid_api_key' });
      return handleGetRequest(res, mReq[1]);
    }

    // ---- admin surface
    if (p === '/admin' || p === '/' || p === '/admin/') {
      if (!rateLimit(ip, 'adminpage', 240, 60000)) return sendError(res, 429, 'rate limit exceeded');
      return serveAdminHtml(res);
    }
    if (p === '/admin/api/session') {
      if (!rateLimit(ip, 'session', 30, 60000)) return sendError(res, 429, 'too many attempts, slow down');
      if (!isAdmin(req, url)) return sendError(res, 401, 'bad admin token', { code: 'invalid_token' });
      return sendJson(res, 200, { ok: true, ...adminState() });
    }
    if (p.startsWith('/admin/api/')) {
      if (!isAdmin(req, url)) return sendError(res, 401, 'bad admin token', { code: 'invalid_token' });
      if (p === '/admin/api/events') return handleAdminEvents(req, res);
      if (p === '/admin/api/state') return sendJson(res, 200, adminState());
      if (p === '/admin/api/reply' && req.method === 'POST') return await handleAdminReply(req, res);
      if (p === '/admin/api/cancel' && req.method === 'POST') return await handleAdminCancel(req, res);
      if (p === '/admin/api/config' && req.method === 'POST') return await handleAdminConfig(req, res);
      if (p === '/admin/api/test-notify' && req.method === 'POST') return await handleAdminTestNotify(req, res);
      if (p === '/admin/api/rotate' && req.method === 'POST') return handleAdminRotate(req, res, url);
      return sendError(res, 404, 'unknown admin route');
    }

    return sendError(res, 404, 'not found: ' + p, { code: 'not_found' });
  } catch (err) {
    console.error('[error]', err);
    if (!res.headersSent) sendError(res, 500, err.message || 'internal error', { type: 'api_error' });
    else res.end();
  }
});

server.requestTimeout = 0;
server.headersTimeout = 60000;
server.timeout = 0;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => {
  loadLog();
  const live = [...requests.values()].filter((r) => r.status === 'pending' && !waiters.has(r.id));
  for (const r of live) {
    // Leftover from a previous process: nobody is holding the socket anymore.
    touch(r, { status: 'expired', note: 'server restarted before this was answered' });
  }
  const line = '='.repeat(64);
  console.log(line);
  console.log('  Human-as-API  ·  OpenAI-compatible endpoint served by a person');
  console.log(line);
  console.log(`  API base   : http://${HOST}:${PORT}/v1   (public: ${PUBLIC_URL || 'not set'})`);
  console.log(`  Admin page : http://127.0.0.1:${PORT}/admin`);
  console.log(`  API key    : ${config.apiKeys.join(', ')}`);
  console.log(`  Admin token: ${config.adminToken}`);
  console.log(`  Notify     : ${config.notify?.enabled ? (config.notify.provider === 'ntfy' ? `${NTFY_SERVER}/${config.notify.topic}` : config.notify.webhook || 'webhook (unset)') : 'disabled'}`);
  console.log(`  Default wait: ${Math.round(config.timeoutMs / 1000)}s   data: ${DATA_DIR}`);
  console.log(line);
  console.log('  Phone: install the ntfy app and subscribe to the topic above.');
  console.log('  curl  : curl -s http://127.0.0.1:' + PORT + '/v1/chat/completions \\');
  console.log('            -H "Authorization: Bearer ' + config.apiKeys[0] + '" \\');
  console.log('            -H "Content-Type: application/json" \\');
  console.log('            -d \'{"model":"human","messages":[{"role":"user","content":"你好"}]}\'');
  console.log(line);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[exit] ${sig}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
