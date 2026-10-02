# Human-as-API

把自己的脑子封装成一个 API。对外暴露一个 **OpenAI 兼容**的 `/v1/chat/completions`，
但后端不接任何模型——请求会进队列，由**你本人**在手机上手打回复，再作为标准响应返回。

零依赖，只有 Node 内置模块。

> 两个文档：**本文**讲怎么部署和运营（隧道、手机、安全、坑）；
> **给调用方的接入说明在 [INTEGRATION.md](INTEGRATION.md)**（各语言片段、超时策略、错误码、行为约定）。

```
客户端 ──POST /v1/chat/completions──▶ 排队 ──通知──▶ 你的手机（ntfy）
   ▲                                                        │
   └────────── 标准 OpenAI JSON / SSE 流 ◀────────── 你打字回复
```

---

## 30 秒跑起来

```bat
cd human-api
node server.mjs
```

首次启动会生成密钥并打印出来，记下这三样：

```
API key    : sk-human-xxxxxxxx        ← 给调用方
Admin token: xxxxxxxx                 ← 给你自己，登录回复台用
Notify     : https://ntfy.sh/human-api-xxxxxxxx   ← 手机订阅这个主题
```

回复台：<http://127.0.0.1:8787/admin>

---

## 手机端怎么用

**方式一（推荐）：ntfy 推送**
1. 手机装 [ntfy](https://ntfy.sh) App（iOS / Android / F-Droid 都有）。
2. 订阅启动日志里那串 `human-api-xxxxxxxx` 主题。
3. 有新请求，手机立刻弹通知，**点通知直接跳进回复台**，且已定位到那条请求。

**方式二：直接开网页**
手机浏览器打开 `https://<你的公网地址>/admin`，输入 admin token（只需输一次，会记住）。
这个页面是移动端优先做的：卡片列表、点开就是对话气泡 + 输入框 + 快捷短语，
新请求进来页面会自动刷新并震动。

---

## 接到公网

### 方案 A：cloudflared 快隧道（免费、免账号，最快）

```bat
tunnel.cmd
```

它会下载 cloudflared 并开一条隧道，输出类似：

```
https://<随机词>-<随机词>-<随机词>.trycloudflare.com
```

把 `config.json` 里的 `publicUrl` 填成这个地址（回复台的「设置」里也能改），
这样手机通知的跳转链接才是对的。

**注意**：快隧道每次重启 URL 都会变，且没有可用性保证，适合自用和演示。

### 方案 B：Cloudflare 命名隧道（URL 固定，仍需本机开机）

```bat
cloudflared tunnel login
cloudflared tunnel create human-api
cloudflared tunnel route dns human-api human.yourdomain.com
cloudflared tunnel run --url http://localhost:8787 human-api
```

### 方案 C：VPS 常驻（不依赖你家电脑开机）

把整个目录拷到服务器，`node server.mjs` 挂在 systemd 后面，
再用 Nginx/Caddy 反代加 HTTPS。监听端口建议不要直接暴露，让反代转发到 `127.0.0.1:8787`。

> 前两种方案的共同点：**你的电脑必须开着**。想让"人"24 小时在线，用方案 C。

---

## 接入现有系统

任何支持自定义 OpenAI 接口的客户端/框架都能直接用。

| 配置项 | 值 |
|---|---|
| Base URL | `https://<公网地址>/v1` |
| API Key | `sk-human-...` |
| Model | `human`（别名 `human-1` / `me`） |

**调用方的完整说明见 [INTEGRATION.md](INTEGRATION.md)** —— 各语言的可复制片段（都实测过）、
GUI 客户端填法、超时策略怎么选、错误码对照、以及会踩的坑。

一句话版本：`stream: true` 是长等待的推荐形态（等待期间服务端持续发 SSE keep-alive 注释行，
内容在回复后一次性作为 delta 推出，然后 `finish_reason: stop` + `[DONE]`）。

---

## 超时：这东西唯一的硬约束

人打字比模型慢得多，所以超时策略是核心。

- 默认给客户端 **300 秒**（`timeout_ms` 可单次覆盖，上限 30 分钟）。
- 超时后返回 **HTTP 408**，body 是标准 OpenAI 错误对象，`code: human_timeout`。
- **但请求不会丢**：它留在待回复队列里（标记「客户端已超时·仍可回复」），
  你晚几分钟回车，答案照样存下来。客户端可以事后取：

```bash
GET /v1/human/requests/{id}     # id 在超时错误的 message 里
```

> 为什么用 408 而不是 504：Cloudflare 等反向代理会把**源站的 5xx 响应体替换成自己的 HTML 错误页**，
> 客户端拿到 `<!DOCTYPE html>` 直接解析失败。这是实测踩出来的坑，换个代理同样要留意。

**客户端侧提示**：GUI 客户端（Cherry Studio / ChatBox / NextChat / open-webui 等）
一般有 30–120 秒的硬超时，接之前先把超时调大，否则你还没打完字它就报错了。

---

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 主接口，支持 `stream` |
| POST | `/v1/completions` | 老式 text completion |
| GET | `/v1/models` | 模型列表 |
| GET | `/v1/human/requests/{id}` | 事后取某条请求的答案 |
| GET | `/healthz` | 存活 + 队列长度 |

管理端（需 admin token）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin` | 手机回复台 |
| GET | `/admin/api/state` | 队列 / 历史 / 配置 |
| GET | `/admin/api/events` | SSE 实时事件 |
| POST | `/admin/api/reply` | `{id, content}` 提交回复 |
| POST | `/admin/api/cancel` | 取消某条请求 |
| POST | `/admin/api/config` | 改超时 / 快捷短语 / 通知 / publicUrl |
| POST | `/admin/api/test-notify` | 发测试通知 |
| POST | `/admin/api/rotate` | 重置 API key |

请求体里多支持两个非标准字段：

- `timeout_ms` —— 这一次调用最多等你多久。
- `stream_options.include_usage` —— 流式末尾补一个 usage 块。

响应里多一个 `x_human` 字段，记录 `request_id` 和 `waited_ms`（这条请求让你等了多久）。

---

## 安全

公网暴露，务必注意：

- **admin token 就是你的后台钥匙**，泄露 = 任何人都能用你的回复台。
  登录接口有按 IP 的限流（30 次/分钟）挡暴力破解，但 token 本身要够长（默认 32 位随机）。
- API key 只保护 `/v1`，且默认单 IP 120 请求/分钟。
- 想换钥匙：回复台「设置」→ 重置 API Key；admin token 改 `data/config.json` 后重启。
- 这套东西**没有 TLS**，HTTPS 由隧道/反代提供。别直接把 8787 端口裸暴露到公网。
- 请求内容会明文落盘（`data/requests.jsonl`），别拿它当机密通道。

---

## 文件结构

```
human-api/
├── server.mjs              # 全部服务端逻辑（零依赖）
├── public/admin.html       # 手机回复台（单页，内联样式与脚本）
├── README.md               # 部署与运营（本文）
├── INTEGRATION.md          # 接入文档（给调用方）
├── test/
│   ├── e2e.mjs             # 34 项端到端协议测试
│   ├── operator.mjs        # 机器人操作员：无人值守时扮演"人"自动回复
│   ├── live-request.mjs    # 手动实测用：发一条真实请求并记录结果
│   └── snippets/           # 文档里的各语言调用片段，可单独运行
├── start.cmd               # 启动服务
├── tunnel.cmd              # 下载 cloudflared 并开公网隧道
├── data/                   # 运行期生成，不要提交
│   ├── config.json         # 密钥、通知、超时（首次启动自动生成）
│   └── requests.jsonl      # 请求流水（append-only）
└── logs/server.log         # 运行日志
```

跑测试：先启动服务，再 `node test/e2e.mjs`。
加 `set BASE=https://xxx.trycloudflare.com` 可以整套跑在公网上，验证隧道是否正常。
`node test/operator.mjs` 会让脚本扮演"人"自动回复，`OP_DELAY_MS` 控制它"思考"多久——
`test/snippets/` 下那些片段就是靠它做到无人值守验证的。

---

## 已知坑

| 现象 | 原因 / 处理 |
|---|---|
| 超时返回一坨 HTML | 反代替换了 5xx 响应体，服务已改用 408 规避 |
| 重启后 URL 变了 | 快隧道是临时的，换命名隧道或 VPS |
| 客户端几十秒就报错 | 客户端自身超时太小，调大或改用流式 |
| 日志文件空的 | Windows 重定向下 stdout 有块缓冲，服务已额外写 `logs/server.log` |
| 手机收不到推送 | 确认订阅的主题一致，回复台「设置」里点「发一条测试通知」自查 |
