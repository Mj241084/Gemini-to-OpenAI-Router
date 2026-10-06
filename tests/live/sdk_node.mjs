// npm i --no-save @google/genai   (فقط برای تست، به package.json اضافه نشود)
// ROUTER_URL=... ROUTER_TOKEN=... node tests/live/sdk_node.mjs
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.ROUTER_TOKEN,
  httpOptions: { baseUrl: process.env.ROUTER_URL },
});
const log = (n, v) => console.log(`✅ ${n}:`, typeof v === "string" ? v.slice(0, 120) : v);

const r1 = await ai.models.generateContent({ model: "auto", contents: "Say pong" });
log("generateContent", r1.text);

let acc = "";
const stream = await ai.models.generateContentStream({ model: "fast", contents: "Count 1 to 5" });
for await (const c of stream) acc += c.text ?? "";
log("generateContentStream", acc);

const emb = await ai.models.embedContent({ model: "auto", contents: "hello", config: { outputDimensionality: 768 } });
log("embedContent dims", emb.embeddings[0].values.length);

const think = await ai.models.generateContent({
  model: "gemini-3.6-flash",
  contents: "hi",
  config: { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } },
});
log("thinkingLevel HIGH (SDK enum casing)", think.text);

const tools = [{ functionDeclarations: [{ name: "get_weather", description: "weather", parameters: { type: Type.OBJECT, properties: { city: { type: Type.STRING } }, required: ["city"] } }] }];
const t1 = await ai.models.generateContent({ model: "auto", contents: "Weather in Tehran? use the tool", config: { tools } });
log("function call", JSON.stringify(t1.functionCalls));
const fc = t1.candidates[0].content; // contains thoughtSignature if the model returned one
const t2 = await ai.models.generateContent({
  model: "auto",
  contents: [
    { role: "user", parts: [{ text: "Weather in Tehran? use the tool" }] },
    fc,
    { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { temp: "25C" } } }] },
  ],
  config: { tools },
});
log("function response turn", t2.text);
