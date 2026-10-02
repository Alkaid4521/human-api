// Snippet 4 from INTEGRATION.md - Node 20+ built-in fetch, no SDK needed.
const BASE = process.env.HUMAN_BASE;
const KEY = process.env.HUMAN_KEY;

const res = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'human',
    messages: [{ role: 'user', content: 'Node 侧也不需要装任何依赖。' }],
    timeout_ms: 600_000,
  }),
  signal: AbortSignal.timeout(700_000),   // 比服务端上限再宽一点
});

if (!res.ok) {
  const err = await res.json().catch(() => ({}));
  throw new Error(`HTTP ${res.status} ${err.error?.code || ''} ${err.error?.message || ''}`);
}

const data = await res.json();
console.log('CONTENT:', data.choices[0].message.content);
console.log('WAITED_MS:', data.x_human.waited_ms);
