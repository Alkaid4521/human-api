"""Snippet 2 from INTEGRATION.md - official openai Python SDK (non-streaming)."""
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

print("CONTENT:", resp.choices[0].message.content)
print("FINISH:", resp.choices[0].finish_reason)
print("USAGE:", resp.usage.total_tokens)
print("X_HUMAN:", resp.model_dump().get("x_human"))
