# pip install google-genai   (فقط محیط تست)
# ROUTER_URL=... ROUTER_TOKEN=... python tests/live/sdk_python.py
import os
from google import genai
from google.genai import types

client = genai.Client(
    api_key=os.environ["ROUTER_TOKEN"],
    http_options=types.HttpOptions(base_url=os.environ["ROUTER_URL"]),
)
print("✅ generate:", client.models.generate_content(model="auto", contents="Say pong").text[:120])
print("✅ stream:", "".join(c.text or "" for c in client.models.generate_content_stream(model="fast", contents="Count 1 to 5"))[:120])
e = client.models.embed_content(model="auto", contents="hello", config=types.EmbedContentConfig(output_dimensionality=768))
print("✅ embed dims:", len(e.embeddings[0].values))
print("✅ count_tokens:", client.models.count_tokens(model="auto", contents="hello world").total_tokens)
