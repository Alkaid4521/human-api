"""Snippet 6 from INTEGRATION.md - timeout + late-answer retrieval.

This is the pattern for callers that cannot hold a socket open for minutes
(serverless functions, cron jobs, chatbots with a hard 30s limit).
"""
import os
import time
import requests

BASE = os.environ["HUMAN_BASE"]
H = {"Authorization": "Bearer " + os.environ["HUMAN_KEY"]}

# 1) 用一个短超时把请求丢出去。人没在 2 秒内回复，服务端回 408。
r = requests.post(
    BASE + "/v1/chat/completions",
    headers=H,
    json={
        "model": "human",
        "timeout_ms": 2_000,
        "messages": [{"role": "user", "content": "这条会超时，但答案不会丢。"}],
    },
    timeout=30,
)
print("STATUS:", r.status_code)

if r.status_code == 408:
    err = r.json()["error"]
    print("CODE:", err["code"])
    # 报错信息里带着 request id，用它稍后回来取答案
    req_id = err["message"].split("id=")[1].split(")")[0].strip()
    print("REQUEST_ID:", req_id)

    # 2) 真实场景里这一步在几分钟后（等着人工回复），这里直接等一会儿
    time.sleep(14)
    got = requests.get(BASE + "/v1/human/requests/" + req_id, headers=H, timeout=30).json()
    print("LATE_STATUS:", got["status"])
    print("LATE_ANSWER:", got["answer"])
else:
    print("UNEXPECTED (a human answered within 2s):", r.text[:200])
