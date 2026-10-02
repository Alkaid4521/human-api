# 接入文档 · Human-as-API

给**调用方**看的东西。服务端怎么部署、手机怎么回复，见 [README.md](README.md)；
这里只讲一件事：**怎么把你的程序接到这个接口上，并且不被"人很慢"这件事坑到。**

接口本身是 OpenAI 兼容的，所以你已经会用了——真正需要理解的是超时。

---

## 0. 拿到三样东西

找运行服务的人要（他那边启动日志里就有）：

| 项 | 形如 | 说明 |
|---|---|---|
| Base URL | `https://xxxx.trycloudflare.com/v1` | 注意结尾带 `/v1` |
| API Key | `sk-human-…` | 放进 `Authorization: Bearer` |
| Model | `human` | 别名 `human-1`、`me`；其实填什么都会被原样回显 |

> 快隧道地址**每次重启都会变**。如果程序里写死了，换个地址就得改配置——所以建议把 base URL 放进环境变量。

---

## 1. 先确认能通

```bash
curl https://xxxx.trycloudflare.com/v1/chat/completions \
  -H "Authorization: Bearer sk-human-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"human","messages":[{"role":"user","content":"你好"}]}'
```

发出去之后**不会有立刻的响应**——那头有个人正在看手机。默认最多等 300 秒。

> Windows 用户注意：PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，参数不一样，
> 必须写 `curl.exe`。`cmd` 里单引号不管用，`-d` 的 JSON 要用双引号转义。

健康检查（不需要 key）：`GET /healthz` → `{"ok":true,"pending":0,...}`。

---

## 2. 各语言接入

以下片段**全部在本机实测跑通**，输出见每段后面的实际结果。

### Python（官方 openai SDK，推荐）

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["HUMAN_BASE"] + "/v1",
    api_key=os.environ["HUMAN_KEY"],
)

resp = client.chat.completions.create(
    model="human",
    messages=[{"role": "user", "content": "你好，请问在吗？"}],
    timeout=600,                          # 客户端愿意等多久（秒），必须大于你打字的耗时
    extra_body={"timeout_ms": 600_000},   # 服务端这次请求的上限（毫秒）
)

print(resp.choices[0].message.content)
print(resp.model_dump().get("x_human"))   # 额外字段要这样读
```

实测输出（openai 2.16.0）：

```
CONTENT: （人工回复）你好，请问在吗？
FINISH: stop
USAGE: 8
X_HUMAN: {'request_id': 'human-muqxdx2k-1da28a', 'waited_ms': 729}
```

`x_human` 是额外字段，不是 SDK 的标准属性，必须走 `model_dump()` 或 `model_extra` 读，直接 `resp.x_human` 拿不到。

### Python（requests 直连，不装 SDK）

```python
import os, requests

r = requests.post(
    os.environ["HUMAN_BASE"] + "/v1/chat/completions",
    headers={"Authorization": "Bearer " + os.environ["HUMAN_KEY"]},
    json={
        "model": "human",
        "messages": [{"role": "user", "content": "用 requests 直连也要能通。"}],
        "timeout_ms": 600_000,
    },
    timeout=700,          # requests 这边的总超时（秒），同样要留够打字时间
)
r.raise_for_status()
data = r.json()
print(data["choices"][0]["message"]["content"])
print(data["x_human"]["waited_ms"])
```

实测：`CONTENT: （人工回复）用 requests 直连也要能通。` / `WAITED_MS: 715`

### Node.js（20+，内置 fetch，零依赖）

```js
const res = await fetch(`${process.env.HUMAN_BASE}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.HUMAN_KEY}`,
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
console.log(data.choices[0].message.content);
console.log(data.x_human.waited_ms);
```

实测：`CONTENT: （人工回复）Node 侧也不需要装任何依赖。` / `WAITED_MS: 793`

> 用 npm 的 `openai` 包的话配置项完全一样（`new OpenAI({ baseURL, apiKey })`），
> 但本机 npm 源被网络环境劫持，这条没实测过，所以不给完整片段。

### 流式（长等待的推荐形态）

```python
stream = client.chat.completions.create(
    model="human",
    messages=[{"role": "user", "content": "流式模式下不用担心首字节迟迟不来。"}],
    stream=True,
    timeout=600,
    extra_body={"timeout_ms": 600_000},
)

for chunk in stream:
    if not chunk.choices:        # 末尾可能只带 usage，choices 为空，必须判空
        continue
    piece = chunk.choices[0].delta.content or ""
    if piece:
        print(piece, end="", flush=True)
```

实测（**故意让人思考 12 秒**，跨过服务端 10 秒一次的 SSE 保活帧）：

```
DELTAS: 1
TEXT: （人工回复）流式模式下不用担心首字节迟迟不来。
```

保活帧是 SSE 注释行，标准解析器会忽略；上面这次跑的 DELTAS 正好是 1，说明没被解析成多余内容。

### 异步轮询（最适合服务端/定时任务）

如果你的运行环境不允许挂住一个 socket 几分钟，就走这条：**发一个短超时的请求拿到 request id，过一会儿回来取答案。**

```python
import time, requests

H = {"Authorization": "Bearer " + os.environ["HUMAN_KEY"]}
BASE = os.environ["HUMAN_BASE"]

r = requests.post(BASE + "/v1/chat/completions", headers=H, timeout=30, json={
    "model": "human",
    "timeout_ms": 2_000,        # 只等 2 秒
    "messages": [{"role": "user", "content": "这条会超时，但答案不会丢。"}],
})

if r.status_code == 408:
    err = r.json()["error"]
    req_id = err["message"].split("id=")[1].split(")")[0].strip()   # 从报错里取出 id

    time.sleep(60)              # 真实场景里这才过了一分钟
    got = requests.get(f"{BASE}/v1/human/requests/{req_id}", headers=H, timeout=30).json()
    print(got["status"], got["answer"])     # answered  <答案>
```

实测输出：

```
STATUS: 408
CODE: human_timeout
REQUEST_ID: human-muqxf6c1-ec61a3
LATE_STATUS: answered
LATE_ANSWER: （人工回复）这条会超时，但答案不会丢。
```

**超时 ≠ 失败**。请求会留在对方待回复队列里标成「客户端已超时·仍可回复」，他晚几分钟敲完照样存下来，你随时能取。这是这套接口跟普通 API 最大的观念差别。

---

## 3. GUI 客户端怎么填

Cherry Studio / ChatBox / NextChat / LobeChat / open-webui 之类，一律找「自定义 OpenAI 兼容服务商」：

| 字段 | 填 |
|---|---|
| API 地址 / Base URL | 你的公网地址 + `/v1` |
| API 密钥 | `sk-human-…` |
| 模型名 | `human`（有的客户端要手动「添加模型」才让填） |

**填完必须做两件事**，否则一定失败：

1. **把超时调到最大**（一般设置项叫「请求超时」「超时时长」）。默认 30–60 秒的话，人还没打完字客户端就报错了。
2. **优先开启流式输出**。流式下客户端通常按"有没有数据流"判活，而不是等完整响应，抗长等待能力强得多。

有的客户端会做「连接测试」，只给几秒钟——那种测试失败不代表接口不通。

---

## 4. 超时怎么选（核心）

| 场景 | 用哪种 | 客户端超时设成 |
|---|---|---|
| 人就在电脑前，随手回 | 非流式 | > 预计打字时间，建议 300–600 秒 |
| 人是"有空才看" | 流式 | 600 秒以上；服务端每 10 秒有保活帧 |
| 服务端/定时任务/无状态函数 | 异步轮询 | 请求 `timeout_ms` 给 1–5 秒，之后轮询取件 |
| 聊天机器人要"秒回" | **不适合** | 这个接口不承诺响应时间 |

请求体里两个控制超时的字段：

- `timeout_ms` —— 服务端这次最多等你多久。范围 1000–1800000（30 分钟），超出会被夹到边界。
- `human_timeout_ms` —— 同义，别名。

都不给就用服务端默认值（出厂 300 秒，运营方可在回复台改）。

---

## 5. 错误码对照

| HTTP | `error.code` | 含义 | 你该做什么 |
|---|---|---|---|
| 400 | `invalid_request_error` | 没给 `messages` / JSON 坏了 / body 超 1 MB | 修请求 |
| 401 | `invalid_api_key` | key 缺失或不对 | 查 key |
| 408 | `human_timeout` | 人没在时限内回复。**消息里带 `id=`** | 解析出 id 后轮询 `/v1/human/requests/{id}` |
| 429 | `rate_limited` | 超过每 IP 120 次/分钟 | 退避重试 |
| 499 | `human_cancelled` | 对方主动点了「取消该请求」 | 当作被拒绝，可换个问法重试 |
| 500 | `api_error` | 服务端内部错误 | 重试 |

**流式的错误不一样**：HTTP 头早就发出去了（200），出错只能从流里传。你会收到一帧
`data: {"error":{"code":"human_timeout",...}}` 然后 `data: [DONE]`。
没处理这个的客户端会显示成"空回复"——接流式时记得判 `chunk` 里有没有 `error`。

---

## 6. 响应里多出来的东西

标准字段之外，多一个 `x_human`：

```json
"x_human": { "request_id": "human-muqxdx2k-1da28a", "waited_ms": 729 }
```

`waited_ms` 是这条请求让你等了多久（毫秒），做监控/告警很有用——**这个数字应该被你记录下来**，
它直接反映对方的响应速度。

另外 `system_fingerprint` 固定是 `"human-v1"`。

---

## 7. 行为约定

**没有会话状态。** 服务端不记得上一轮。要多轮对话，客户端每次把完整历史发过来——这是标准 OpenAI 行为，照做就行。

**你的消息人会看到全部。** 包括 `system` 消息。转给人工时 transcript 是按角色原样渲染的。
所以：不要往里塞密钥；如果给了很长的 system prompt，对方也会看到全文。

**多模态输入会被降级成文字。** `content` 传数组时，`image_url` 那块变成 `[图片] <url>`，
图片本身不会展示给对方。想传图就贴可访问的链接。

**这些参数会被忽略**：`temperature`、`top_p`、`n`、`max_tokens`、`tools` / `function calling`。
不会报错，只是没作用——对方是人，没有采样温度。
**但 `tools` 要小心**：返回的是纯文本，不支持工具调用，依赖 function calling 的框架会解析失败。

**`model` 字段任意。** 你传什么，响应里就回显什么，不校验。有些客户端强制要 `gpt-4o` 之类的名字，那就直接填，能用。

**流式的形状**：先一帧只带 `delta.role="assistant"` 的空内容，等待期间是 SSE 注释保活帧，
人回复后内容作为**单个** delta 一次性推出，然后 `finish_reason:"stop"`，最后 `[DONE]`。
不要假设内容会分成很多块。

---

## 8. 常见问题

**请求发出去了，半天没动静？**
正常。默认最多 300 秒。先确认对方手机上的 ntfy 通知收到没有。

**一直超时？**
对方可能不在。把 `timeout_ms` 调大，或者改用异步轮询模式——反正超时后答案不会丢，你回头取得到。

**返回 `<!DOCTYPE html>`？**
不是这个接口的问题，是中间层。反代（Cloudflare 等）会把源站的 5xx 响应体换成自己的 HTML 错误页。
本服务已把超时码改成 408 规避，但如果你在前面又加了一层代理，留意它有没有同类行为。

**客户端报"模型不存在"？**
填 `human`。若客户端有模型下拉框但列表是空的，说明它没调 `GET /v1/models`，手动添加一个名为 `human` 的模型即可。

**能不能并发？**
能。每个请求独立排队，对方逐条回。压测性质的高并发会撞 429，也没意义——瓶颈是人的手速。

**服务器重启后我发的请求呢？**
排队中的请求会随进程消失（日志里留了记录，但不会再有响应）。已在队列里没被回复的会在重启时标记为"客户端已超时"。

---

## 9. 这份文档里的片段跑过没有

跑过。验证方式：用 `test/operator.mjs` 扮演人工操作员（轮询队列并自动回复固定内容），
再逐个执行 `test/snippets/` 下的脚本。

| 片段 | 文件 | 结果 |
|---|---|---|
| Python openai SDK | `test/snippets/py_openai.py` | 通过 |
| Python requests | `test/snippets/py_requests.py` | 通过 |
| Node 内置 fetch | `test/snippets/node_fetch.mjs` | 通过 |
| 流式（跨 10s 保活帧） | `test/snippets/py_stream.py` | 通过 |
| 异步轮询（408 → 事后取） | `test/snippets/py_async_poll.py` | 通过 |
| 协议层全量回归（34 项） | `test/e2e.mjs` | 本地 + 公网各 34/34 |

自己复跑：

```bat
node server.mjs                    :: 一个窗口
node test/operator.mjs             :: 另一个窗口，扮演人
set HUMAN_BASE=http://127.0.0.1:8787
set HUMAN_KEY=sk-human-xxxx
python -X utf8 test/snippets/py_openai.py
```

`OP_DELAY_MS=12000 node test/operator.mjs` 可以把"人"调慢，用来复现超时与保活路径。
