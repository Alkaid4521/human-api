"""Snippet 5 from INTEGRATION.md - streaming, the recommended mode for slow humans."""
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["HUMAN_BASE"] + "/v1",
    api_key=os.environ["HUMAN_KEY"],
)

stream = client.chat.completions.create(
    model="human",
    messages=[{"role": "user", "content": "流式模式下不用担心首字节迟迟不来。"}],
    stream=True,
    timeout=600,                          # httpx 的读超时；服务端每 10 秒有保活帧，不会触发它
    extra_body={"timeout_ms": 600_000},
)

deltas = 0
text = ""
for chunk in stream:
    if not chunk.choices:                 # 末尾可能带 usage，choices 为空
        continue
    piece = chunk.choices[0].delta.content or ""
    if piece:
        deltas += 1
        text += piece

print("DELTAS:", deltas)
print("TEXT:", text)
