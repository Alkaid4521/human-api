"""Snippet 3 from INTEGRATION.md - raw HTTP with requests (no SDK needed)."""
import os
import requests

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

print("CONTENT:", data["choices"][0]["message"]["content"])
print("WAITED_MS:", data["x_human"]["waited_ms"])
