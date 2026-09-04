"""Example client. Requires `pip install openai`; secrets come from environment."""
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["OPENAI_BASE_URL"],
    api_key=os.environ["OPENAI_API_KEY"],
    timeout=660,
)
request = dict(
    model=os.environ.get("OPENAI_MODEL", "local-default"),
    messages=[{"role": "user", "content": "Reply with exactly OK."}],
    max_tokens=32,
    temperature=0.2,
    top_p=0.9,
)
response = client.chat.completions.create(**request)
print(response.choices[0].message.content)
print("Usage:", response.usage)
print("Inference:", (response.model_extra or {}).get("inference"))

for chunk in client.chat.completions.create(
    **request, stream=True, stream_options={"include_usage": True}
):
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
    if chunk.usage:
        print("\nUsage:", chunk.usage)
        print("Inference:", (chunk.model_extra or {}).get("inference"))
