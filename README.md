# Gemini ⇄ Hermes Router (Cloudflare Worker)

یک Cloudflare Worker که به عنوان یک **base URL سازگار با OpenAI** جلوی Google AI Studio
(مدل‌های Gemini) و اختیاری OpenRouter می‌شیند، بین چند مدل و چند API key به‌صورت هوشمند
چرخش (rotation) و fallback انجام می‌ده، ریت‌لیمیت هرکدوم رو جدا پیگیری می‌کنه، همه‌چیز رو
لاگ می‌گیره، و به‌عنوان اندپوینت مرکزی هوش مصنوعی برای همه‌ی پروژه‌های دیگر (مثل
`gemini-personal-agent`) عمل می‌کنه — بدون این‌که در جریان درخواست‌ها وقفه‌ای ایجاد کنه.

---

## ۱) معماری خیلی خلاصه

```
Caller (Hermes / gemini-personal-agent / ...)
        │
        ▼  (OpenAI-compatible request)
   این Worker
        │
        ├─ /v1/chat/completions  ──▶ کلید+مدل انتخاب‌شده ──▶ Google AI Studio یا OpenRouter
        ├─ /v1/embeddings        ──▶ کلید+مدل انتخاب‌شده ──▶ Google Native embedContent
        │
        ▼
Durable Object (SQLite)
مدل‌ها (با kind/provider/order) / کلیدها / ریت‌لیمیت / cooldown / circuit breaker / لاگ‌ها
```

- **Worker** (`src/index.js`): درخواست ورودی رو می‌گیره، مدل/کلید مناسب رو از Durable
  Object می‌پرسه، درخواست رو به upstream مناسب فوروارد می‌کنه، و بر اساس نتیجه (موفق /
  ۴۲۹ / ۵۰۳ / ...) تصمیم می‌گیره کلید یا مدل رو عوض کنه یا نه.
- **Durable Object** (`src/routerDO.js`): تنها جایی‌ست که state واقعی نگه‌داری می‌شه —
  لیست مدل‌ها (با اولویت order، provider، kind، rpm، rpd، جدول thinking level)، لیست
  API keyها (هرکدوم با provider خودش)، شمارنده‌ی مصرف هر (کلید, مدل) در دقیقه/روز جاری،
  cooldown بعد از خطا، circuit breaker برای مدل‌های ناپایدار، و جدول لاگ‌ها. چون روی
  پلن رایگان Cloudflare فقط Durable Object با backend مبتنی بر **SQLite** (یعنی
  `new_sqlite_classes`) مجاز است، دقیقاً همین رو در `wrangler.toml` تنظیم کرده‌ایم.

نکته‌ی مهم: چون تمام state داخل یک Durable Object نگه‌داری می‌شه، انتخاب کلید/مدل و
به‌روزرسانی شمارنده‌ها **atomic و بدون race condition** هستند.

### مدل‌ها سه نوع (`kind`) دارند

هر مدل یکی از این سه مقدار رو برای `kind` داره: **`chat`** (پیش‌فرض — چت معمولی و
tool-calling)، **`tts`** (تبدیل متن به گفتار)، **`embedding`**. هر endpoint فقط بین
مدل‌های هم‌kind خودش fallback می‌کنه — یعنی یک درخواست TTS هیچ‌وقت، حتی روی خطا، به
یک مدل چت نمی‌ره و برعکس.

---

## ۲) پیش‌نیازها

- Node.js نسخه‌ی ۱۸ به بالا (ترجیحاً ۲۰+)
- یک اکانت Cloudflare (پلن Free کافیه)
- دسترسی به اجرای `npx wrangler ...` (نیازی به نصب سراسری نیست)

---

## ۳) نصب و Deploy — قدم‌به‌قدم

```bash
cd Router
npm install
npx wrangler login

# توکن‌های امنیتی رو تعیین کن (هرکدوم یک رشته‌ی تصادفی و بلند)
npx wrangler secret put PROXY_TOKEN
# > مقداری که هر caller (Hermes، ایجنت شخصی و...) باید به‌عنوان
#   "Authorization: Bearer <PROXY_TOKEN>" بفرسته

npx wrangler secret put ADMIN_TOKEN
# > مقداری که خودت برای مدیریت مدل/کلید و مشاهده‌ی آمار استفاده می‌کنی

npx wrangler deploy
```

بعد از `deploy`، آدرسی شبیه این می‌گیری:

```
https://gemini-hermes-router.<your-subdomain>.workers.dev
```

این آدرس (بدون `/v1` انتهاش برای پروژه‌ی ایجنت، یا با `/v1` برای Hermes) همون base URL
است.

> برای توسعه‌ی محلی: فایل `.dev.vars.example` رو کپی کن به `.dev.vars` و مقادیر
> `PROXY_TOKEN` / `ADMIN_TOKEN` رو داخلش بنویس، بعد `npm run dev` رو بزن. این فایل
> commit نمی‌شه (در `.gitignore` هست).

---

## ۴) اضافه‌کردن مدل‌ها و API keyها

### راه ۱ (پیشنهادی): Admin API

**سریع‌ترین راه برای شروع:** اندپوینت seed همون ۳ مدل و ۵ کلید پیش‌فرض رو یک‌جا وارد
می‌کنه:

```bash
curl -X POST https://<your-worker>.workers.dev/admin/seed \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**افزودن یک مدل چت** (`POST /admin/models`):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "name": "gemini-3.6-flash",
    "provider": "google",
    "kind": "chat",
    "order": 1,
    "rpm": 5,
    "rpd": 20,
    "thinking_levels": ["minimal", "low", "medium", "high"],
    "default_thinking": "high",
    "enabled": true
  }'
```

**افزودن مدل TTS** (طبق تصمیم فنی این پروژه، مدل‌های TTS گوگل از مسیر بومی
`generateContent` رد می‌شن، نه از لایه‌ی بتای OpenAI-compat — به بخش ۷ مراجعه کن):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "name": "gemini-2.5-flash-preview-tts",
    "provider": "google",
    "kind": "tts",
    "order": 1,
    "rpm": 5,
    "rpd": 20,
    "thinking_levels": []
  }'
```

**افزودن مدل embedding** (طبق تصمیم فنی مشابه، از `embedContent` بومی رد می‌شه):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "name": "gemini-embedding-2",
    "provider": "google",
    "kind": "embedding",
    "order": 1,
    "rpm": 10,
    "rpd": 100,
    "thinking_levels": []
  }'
```

**ویرایش یک مدل** (`PATCH /admin/models/:name`):
```bash
curl -X PATCH https://<your-worker>.workers.dev/admin/models/gemini-3.6-flash \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "rpm": 10, "rpd": 50 }'
```

**غیرفعال/حذف یک مدل:**
```bash
curl -X PATCH https://<your-worker>.workers.dev/admin/models/gemini-3.7-flash \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "enabled": false }'

curl -X DELETE https://<your-worker>.workers.dev/admin/models/gemini-3.7-flash \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**افزودن یک API key:**
```bash
curl -X POST https://<your-worker>.workers.dev/admin/keys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "api_key": "AQ.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "label": "key-6", "provider": "google" }'
```

**افزودن چند کلید با هم (bulk):**
```bash
curl -X POST https://<your-worker>.workers.dev/admin/keys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "keys": [
      { "api_key": "AQ.KEY_A...", "label": "key-6", "provider": "google" },
      { "api_key": "AQ.KEY_B...", "label": "key-7", "provider": "google" }
    ]
  }'
```

**غیرفعال یا حذف یک کلید:**
```bash
curl -X PATCH https://<your-worker>.workers.dev/admin/keys/6 \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "enabled": false }'

curl -X DELETE https://<your-worker>.workers.dev/admin/keys/6 \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**دیدن لیست فعلی مدل‌ها / کلیدها:**
```bash
curl https://<your-worker>.workers.dev/admin/models -H "Authorization: Bearer <ADMIN_TOKEN>"
curl https://<your-worker>.workers.dev/admin/keys   -H "Authorization: Bearer <ADMIN_TOKEN>"
# برای دیدن مقدار کامل کلید (نه ماسک‌شده): ?reveal=1
```

### راه ۲: کوئری خام SQL

```bash
curl -X POST https://<your-worker>.workers.dev/admin/query \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "sql": "INSERT INTO api_keys (api_key, label, provider, enabled, created_at) VALUES (?,?,?,?,?)",
    "params": ["AQ.xxxxxxxx", "key-1", "google", 1, 1735000000000]
  }'
```
⚠️ این اندپوینت خیلی قدرتمنده (هر SQL دلخواهی، از جمله `DROP TABLE`)؛ فقط پشت
`ADMIN_TOKEN` محافظت می‌شه.

---

## ۵) بات تلگرام — مدیریت بدون هیچ لاگین

### راه‌اندازی
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN       # از @BotFather
npx wrangler secret put TELEGRAM_OWNER_CHAT_ID   # از @userinfobot
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # اختیاری، یک رشته‌ی تصادفی

npx wrangler deploy

curl "https://<your-worker>.workers.dev/admin/telegram/setup" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```
بعد توی تلگرام `/start` رو بزن.

### دستورات
```
/status                  — وضعیت لحظه‌ای هر کلید/مدل + circuit breaker
/models                  — لیست مدل‌ها با اولویت، provider، kind
/priority                — تغییر اولویت با دکمه‌های ⬆️⬇️
/keys                    — لیست کلیدها (ماسک‌شده)
/logs [تعداد] [status]   — لاگ‌های اخیر
/stats [ساعت]            — آمار تجمیعی

/addmodel <name> <order> <rpm> <rpd> [levels_csv|none] [default] [provider=openrouter] [kind=tts|embedding]
/addkey <api_key> [label] [provider=openrouter]

/enablemodel <name> — /disablemodel <name>
/enablekey <id>     — /disablekey <id>
/delmodel <name>
/delkey <id>

/seed   — ثبت خودکار مدل‌ها و کلیدهای اولیه
/help
```

هر وقت یک خطا واقعاً به caller برگرده (نه یک retry داخلی که خودش حل شده)، همون لحظه یک
پیام 🚨 در همین چت دریافت می‌کنی.

---

## ۶) اتصال از یک caller (Hermes یا هر SDK سازگار با OpenAI)

```yaml
base_url: https://<your-worker>.workers.dev/v1
api_key:  <همون مقدار PROXY_TOKEN>
model:    auto   # یا اسم دقیق یک مدل - در هر دو حالت fallback حفظ می‌شه
```

اگه بخوای در یک درخواست خاص سطح thinking رو خودت مشخص کنی، فیلد `reasoning_effort` رو
در بدنه بفرست (مثلاً `"reasoning_effort": "low"`).

---

## ۶.۱) اتصال از Anthropic Messages API و Claude Code

این روتر علاوه بر لایه‌ی سازگار با OpenAI، از استاندارد **Anthropic Messages API** نیز پشتیبانی کامل می‌کند:
- `POST /v1/messages`: پشتیبانی کامل از هر دو حالت non-streaming و streaming (رویدادهای SSE استاندارد Anthropic).
- `POST /v1/messages/count_tokens`: محاسبه‌ی سریع تعداد توکن‌های پرامپت با اتصال مستقیم به `:countTokens` بومی گوگل.
- احراز هویت با هدر `x-api-key: <PROXY_TOKEN>` یا `Authorization: Bearer <PROXY_TOKEN>`.
- مدیریت خودکار امضای تفکر Gemini 3 (`thoughtSignature`) در هر دو حالت استریم و غیر-استریم برای مکالمات چندمرحله‌ای ابزار (Multi-turn Tool Use).

### اتصال Claude Code به روتر

قبل از اجرای `claude` متغیرهای زیر را تنظیم کن (نکته‌ی حیاتی: `ANTHROPIC_API_KEY=""` باید صریحاً خالی گذاشته شود تا کلاینت به سراغ لاگین رسمی نرود):

```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.workers.dev"
export ANTHROPIC_AUTH_TOKEN="<همون مقدار PROXY_TOKEN>"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL="auto"
export ANTHROPIC_SMALL_FAST_MODEL="fast"

claude
```

برای دائمی کردن این تنظیمات در سیستم، فایل `~/.claude/settings.json` را باز یا ایجاد کرده و بخش `env` را اضافه کن:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<your-worker>.workers.dev",
    "ANTHROPIC_AUTH_TOKEN": "<همون مقدار PROXY_TOKEN>",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_MODEL": "auto",
    "ANTHROPIC_SMALL_FAST_MODEL": "fast"
  }
}
```

> برای مستندات کامل فنی این پل (شامل تاریخچه‌ی مشکلات واقعی که با تست زنده کشف
> و حل شدن — امضای تفکر در حالت استریم، تبدیل schema از blocklist به allowlist،
> و شکل دقیق بدنه‌ی `:countTokens`)، به `anthropic-bridge-migration.md` مراجعه کن.

---

## ۷) TTS — چرا از مسیر بومی گوگل رد می‌شه

نسخه‌ی اول این پروژه TTS رو از همون لایه‌ی OpenAI-compat (`modalities: ["text","audio"]`)
رد می‌کرد. در عمل این مسیر مشکلاتی نشون داد که با تعویض مدل/ولوم حل نمی‌شدن (لایه‌ی بتای
گوگل). برای همین مسیر TTS برای مدل‌های `provider=google` و `kind=tts` مستقیم به
endpoint بومی `generateContent` وصل شده (`callGoogleNativeTts` در `src/index.js`) —
هنوز از همون سیستم چرخش کلید/فال‌بک استفاده می‌کنه، فقط upstream URL و بدنه‌ی درخواست
فرق داره.

نکته‌ی فنی: خروجی بومی TTS گوگل **PCM خام بدون هدر** است (mimeType مثل
`audio/L16;rate=24000`)، نه WAV/MP3 آماده. `src/util.js`'s `pcmToWavBase64` یک هدر WAV
استاندارد ۴۴ بایتی دور دیتا می‌پیچه تا خروجی نهایی قابل پخش در هر پلیری (از جمله
تلگرام) باشه. نام صدا (`voice`) هم به‌صورت خودکار نرمال‌سازی می‌شه (اولین حرف بزرگ،
بقیه کوچک — مثلاً `kore` یا `KORE` هر دو به `Kore` تبدیل می‌شن که فرمت مورد انتظار
مدل‌های بومی گوگل است).

فراخوانی از سمت caller دقیقاً همون فرمت OpenAI-compat قبلیه:
```bash
curl -X POST https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "modalities": ["text", "audio"],
    "audio": { "voice": "Kore", "format": "wav" },
    "messages": [{ "role": "user", "content": "متنی که باید خونده بشه" }]
  }'
```
پاسخ صدا رو به‌صورت WAV base64 در `choices[0].message.audio.data` و متن گفته‌شده رو
در `choices[0].message.audio.transcript` برمی‌گردونه.

---

## ۸) `/v1/embeddings` — چرا از مسیر بومی گوگل رد می‌شه

مشابه TTS، این endpoint عمداً از لایه‌ی OpenAI-compat گوگل استفاده *نمی‌کنه*. طبق
گزارش‌های موجود، پارامتر استاندارد `dimensions` روی اون لایه برای مدل‌های Gemini نادیده
گرفته می‌شه — یعنی ممکنه بی‌سروصدا بردار ۳۰۷۲بعدی بگیری به‌جای ۷۶۸بعدی که خواستی، که
می‌تونه یک دیتابیس برداری با بعد ثابت (مثل Vectorize) رو بی‌سروصدا خراب کنه. برای همین
مستقیم به API بومی گوگل (`:embedContent` / `:batchEmbedContents`) وصل می‌شه که پارامتر
`output_dimensionality` رو مطمئناً رعایت می‌کنه.

```bash
curl -X POST https://<your-worker>.workers.dev/v1/embeddings \
  -H "Authorization: Bearer <PROXY_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "model": "auto", "input": "متنی که باید امبد بشه", "dimensions": 768 }'
```
خروجی استاندارد OpenAI-embeddings: `{"data":[{"embedding":[...],"index":0}],...}`.

---

## ۹) منطق rate-limit، فالبک و circuit breaker (خلاصه)

1. برای هر (کلید, مدل) دو شمارنده: مصرفِ **این دقیقه** و **این روز**؛ روز در ساعت
   **۱۲:۳۰ ظهر به وقت ایران** ریست می‌شه (`getIranDayWindow` در `src/util.js`).
2. قبل از هر درخواست، Worker بین مدل‌های فعالِ **هم‌kind** (به ترتیب `order`) و کلیدهای
   **هم‌provider**، اونی که هم rpm هم rpd جا داره و cooldown نداره و بیشترین حاشیه‌ی
   مصرف رو داره انتخاب می‌کنه.
3. **۴۲۹** → همون کلید برای همون مدل موقتاً کنار گذاشته می‌شه، تلاش با کلید بعدی همون
   مدل.
4. **۵۰۲/۵۰۳/۵۰۴** یا خطای شبکه → کل مدل کنار گذاشته می‌شه، تلاش با مدل بعدی. بعد از
   **۳ بار پشت‌سرهم** روی یک مدل، آن مدل ۶۰ ثانیه کاملاً از چرخه‌ی انتخاب خارج می‌شه
   (circuit breaker، `MODEL_FAIL_THRESHOLD`/`MODEL_UNAVAILABLE_COOLDOWN_MS` در
   `config.js`) تا درخواست‌های بعدی حتی امتحانش هم نکنن.
5. **۴۰۰** → fail-fast، بدون retry (معمولاً یعنی خودِ درخواست مشکل داره).
6. فقط درخواست‌های واقعاً موفق (HTTP 200) روی شمارنده‌ی rpm/rpd حساب می‌شن.
7. تمام رویدادها async با `ctx.waitUntil(...)` لاگ می‌شن.

---

## ۱۰) OpenRouter به‌عنوان provider دوم

هر مدل و هر کلید یک فیلد `provider` دارن (`google` یا `openrouter`). کلیدها فقط با
مدل‌های همون provider جفت می‌شن. آدرس upstream و فرمت `reasoning`/`reasoning_effort`
بر اساس provider خودکار انتخاب می‌شه.

```bash
npx wrangler secret put OPENROUTER_SITE_URL   # اختیاری، برای هدر HTTP-Referer
npx wrangler secret put OPENROUTER_SITE_NAME  # اختیاری، برای هدر X-Title
```

نمونه‌ی افزودن یک مدل OpenRouter با اولویت پایین‌تر (فقط وقتی همه‌ی مدل‌های Google
exhausted شدن fallback بهش می‌رسه):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "name": "meta-llama/llama-3.3-70b-instruct:free",
    "provider": "openrouter",
    "order": 9,
    "rpm": 20,
    "rpd": 200,
    "thinking_levels": []
  }'
```

---

## ۱۱) مانیتورینگ

```bash
curl https://<your-worker>.workers.dev/admin/status -H "Authorization: Bearer <ADMIN_TOKEN>"
curl "https://<your-worker>.workers.dev/admin/logs?limit=50" -H "Authorization: Bearer <ADMIN_TOKEN>"
curl "https://<your-worker>.workers.dev/admin/logs?status=error&limit=50" -H "Authorization: Bearer <ADMIN_TOKEN>"
curl "https://<your-worker>.workers.dev/admin/stats?hours=24" -H "Authorization: Bearer <ADMIN_TOKEN>"
npx wrangler tail   # لاگ زنده worker
```

---

## ۱۲) رفع خطای «missing a thought_signature»

مدل‌های Gemini 3 روی هر tool call یک `thought_signature` می‌ذارن که باید عیناً در تماس
بعدی برگردونده بشه. چون کلاینت‌های استاندارد OpenAI (مثل Hermes، یا ایجنت شخصی خودمون)
فیلد غیراستاندارد `extra_content.google.thought_signature` رو نمی‌شناسن و وقتی
تاریخچه رو بازسازی می‌کنن این فیلد گم می‌شه، این خطا در مکالمات چندمرحله‌ای رخ می‌ده.
`ensureThoughtSignatures()` در `src/index.js` قبل از فوروارد هر درخواست، هر tool_call
بدون امضای واقعی رو با مقدار placeholder رسمی گوگل
(`context_engineering_is_the_way_to_go`) پر می‌کنه — بدون این‌که امضای واقعی موجود رو
overwrite کنه. نیازی به کار اضافه نیست.

> همین مکانیزم برای مسیر Anthropic (`/v1/messages`) هم در هر دو حالت streaming و
> non-streaming پیاده‌سازی شده (`src/anthropicTranslate.js`) — جزئیات کشف باگ اولیه‌ی
> نسخه‌ی streaming در `anthropic-bridge-migration.md` بخش ۳.۱.

---

## ۱۳) خلاصه‌ی env vars / secrets

| نام | نوع | توضیح |
|---|---|---|
| `PROXY_TOKEN` | secret | توکنی که هر caller باید به‌عنوان `Authorization: Bearer ...` بفرسته |
| `ADMIN_TOKEN` | secret | توکن مدیریت `/admin/*` (و ثبت خودکار وبهوک تلگرام) |
| `TELEGRAM_BOT_TOKEN` | secret | توکن بات مدیریتی روتر |
| `TELEGRAM_OWNER_CHAT_ID` | secret | chat_id خودت؛ بدون این، هر کسی که بات رو پیدا کنه می‌تونه ازش استفاده کنه |
| `TELEGRAM_WEBHOOK_SECRET` | secret (اختیاری) | جلوگیری از جعل درخواست وبهوک |
| `OPENROUTER_SITE_URL` | secret (اختیاری) | هدر `HTTP-Referer` برای provider=openrouter |
| `OPENROUTER_SITE_NAME` | secret (اختیاری) | هدر `X-Title` برای provider=openrouter |
| `DISPLAY_TIMEZONE` | var | فقط جنبه‌ی نمایشی؛ منطق واقعی ریست در کد است |

---

## ۱۴) امنیت

- `PROXY_TOKEN` و `ADMIN_TOKEN` رو حتماً با `wrangler secret put` ست کن، نه در
  `wrangler.toml`.
- اندپوینت‌های `/admin/*` بدون `ADMIN_TOKEN` صحیح ۴۰۱ برمی‌گردونن.
- `/admin/query` معادل دسترسی کامل به دیتابیسه؛ فقط برای خودت استفاده کن.
- کلیدهای واقعی هیچ‌وقت بدون `?reveal=1` کامل نمایش داده نمی‌شن.

---

## ۱۵) محدودیت‌های شناخته‌شده

- شمارش توکن برای پاسخ‌های استریم‌شده best-effort است.
- بازه‌ی ریست روزانه (۱۲:۳۰ ظهر ایران) در `getIranDayWindow` قابل ویرایشه اگه سهمیه‌ی
  واقعی گوگل زمان دیگه‌ای ریست بشه.
- روی خطای ۴۰۰، Worker عمداً retry نمی‌کنه.
- فقط `/v1/chat/completions`، `/v1/embeddings`، `/v1/models`، `/v1/messages` و `/v1/messages/count_tokens` پیاده‌سازی شده‌اند.
- تبدیل schema ابزارها (`src/nativeTranslate.js`) بر پایه‌ی یک **allowlist قطعی** از
  فیلدهای تاییدشده‌ی Gemini Schema است، نه blocklist — هر کلید JSON-Schema که در
  این allowlist نباشه بی‌سروصدا drop می‌شه (نه ۴۰۰). جزئیات کامل در
  `anthropic-bridge-migration.md` بخش ۳.۲.
- برای مسیر Anthropic، `stop_reason` مربوط به این‌که کدوم `stop_sequence` دقیقاً
  باعث توقف شده رو Gemini تفکیک نمی‌کنه؛ همه‌چیز به `end_turn` فروکاسته می‌شه.

موفق باشی! برای مدل جدید فقط با همون الگوی بخش ۴ یک `POST /admin/models` بزن — نیازی
به redeploy نیست.