# مستندات فنی: پل ارتباطی Anthropic Messages API ⇄ Google Native (`/v1/messages`)

این سند تاریخچه‌ی کامل فنی، تصمیم‌های معماری، و مشکلات واقعی (و راه‌حل‌هاشون) مربوط به
اضافه‌کردن پشتیبانی از **Anthropic Messages API** به `gemini-hermes-router` رو مستند
می‌کنه — تا برای Claude Code (و هر کلاینت دیگه‌ای که با پروتکل Anthropic صحبت می‌کنه)
قابل استفاده باشه. هدف این سند، مرجع بودن برای هر کار مشابه در آینده‌ست، نه فقط یک
changelog.

---

## ۱) چرا این پل لازم بود

می‌خواستیم از **Claude Code** (و هر SDK دیگه‌ای که پروتکل رسمی Anthropic رو حرف می‌زنه)
بدون خرید سابسکریپشن Claude استفاده کنیم — با اتصال به همون زیرساخت موجود روتر
(چرخش کلید، فال‌بک، ریت‌لیمیت روی Gemini). چون Gemini هیچ لایه‌ی سازگار با Anthropic
Messages API نداره، خودمون باید یک لایه‌ی ترجمه‌ی دوطرفه می‌ساختیم:

```
Claude Code (یا هر کلاینت Anthropic)
        │  (Anthropic Messages API shape، x-api-key auth)
        ▼
   POST /v1/messages  یا  POST /v1/messages/count_tokens
        │
        ▼  (ترجمه در src/anthropicTranslate.js)
   Google Native generateContent / streamGenerateContent / countTokens
```

نکته‌ی مهم معماری: جهت این پل **برعکس** چیزیه که شاید اول به ذهن برسه. اینجا caller
(Claude Code) فرمت Anthropic رو حرف می‌زنه و ما درخواستش رو برای Google ترجمه می‌کنیم
و جواب Google رو به فرمت Anthropic برمی‌گردونیم — نه برعکس. این هیچ ربطی به یک اکانت
Anthropic واقعی نداره؛ آخر تا آخر خط، upstream واقعی همیشه Google Gemini‌ست.

---

## ۲) فایل‌ها و اندپوینت‌های جدید

| فایل/اندپوینت | نقش |
|---|---|
| `src/anthropicTranslate.js` | کل منطق ترجمه‌ی دوطرفه (request/response/streaming/count_tokens) |
| `POST /v1/messages` | معادل Anthropic برای چت — non-streaming و streaming |
| `POST /v1/messages/count_tokens` | تخمین توکن پرامپت، بدون واقعاً تولید پاسخ |
| `GET /v1/models` | حالا **دوگانه** است — بر اساس هدر `anthropic-version`/`x-api-key` تشخیص می‌ده کدوم شکل پاسخ (OpenAI یا Anthropic) رو برگردونه |
| `src/util.js` → `isAuthorizedAnthropicStyle`, `extractApiKeyHeader`, `anthropicError` | کمکی‌های auth و شکل خطای مخصوص Anthropic |

مکانیزم انتخاب مدل/کلید (`pickCandidate` در `routerDO.js`) **هیچ تغییری نکرد** —
`auto`/`fast`/`stable` و فال‌بک خودکار روی مدل نامعتبر از قبل دقیقاً همون رفتاری رو
داشت که برای این مسیر هم لازم بود.

---

## ۳) مشکلات واقعی که با تست زنده کشف و حل شدن

هیچ‌کدوم از موارد زیر از روی مستندات حدس زده نشدن — همه با تست زنده (curl مستقیم به
`generateContent`، یا اجرای واقعی Claude Code) کشف و تایید شدن. این روش‌شناسی («فرض
نکن، تست کن») همون چیزیه که در `cloudflare-projects-lessons-learned.md` بخش ۴ مستند
شده، و اینجا دوباره (و با موفقیت) به کار گرفته شد.

### ۳.۱) امضای تفکر (`thoughtSignature`) در حالت استریم

**مشکل:** در مسیر غیر-استریم، وقتی Gemini یک `tool_use` برمی‌گردوند، امضای Gemini-3
رو روی بلوک stash می‌کردیم (`_google_thought_signature`) تا در نوبت بعد بازیابی بشه.
اولین نسخه‌ی مسیر **استریم** این کار رو نمی‌کرد — یعنی دقیقاً جایی که Claude Code
(که پیش‌فرض streaming است و مدام چند دور ابزار پشت‌سرهم می‌زنه) بیشترین نیاز رو بهش
داشت، پوشش نداشت.

**راه‌حل:** در `createAnthropicSseTransformer`، همون فیلد `_google_thought_signature`
مستقیم روی payload رویداد `content_block_start` برای بلوک `tool_use` قرار گرفت — دقیقاً
هم‌الگوی مسیر non-stream. تست واحد اختصاصی (`Test 9`) این رفت‌وبرگشت رو (از streaming
response تا ورودی نوبت بعد) end-to-end پوشش می‌ده.

### ۳.۲) تبدیل schema ابزارها: از Blocklist به Allowlist

این بزرگ‌ترین و پرتکرارترین دسته‌ی مشکل بود — **سه بار پشت‌سرهم** یک کلید جدید و
غیرمنتظره‌ی JSON Schema باعث ۴۰۰ شد:

1. `additionalProperties` (از قبل، مسیر OpenAI هم داشتش)
2. `exclusiveMinimum` / `exclusiveMaximum` (اولین برخورد واقعی با ابزارهای built-in
   خودِ Claude Code)
3. `propertyNames` (دور دوم Claude Code، با ابزارهای متفاوت)

**چرا blocklist شکست خورد:** ابزارهای built-in Claude Code (Bash, Read, Write, Edit,
Glob, Grep, ...) با کامپایلرهای مدرن schema (Zod، Pydantic، Draft 2020-12) تولید
می‌شن که دائم کلیدهای جدید JSON-Schema اضافه می‌کنن. حدس‌زدن هر کلید بعدی، یک بازی
موش‌وگربه‌ی بی‌پایانه.

**راه‌حل نهایی — Allowlist قطعی، نه blocklist:** به‌جای حدس‌زدن چی رو باید حذف کنیم،
دقیقاً مشخص کردیم چی مجازه — با **تست زنده‌ی تک‌تک فیلدها** روی
`gemini-3.6-flash:generateContent` (نه از روی مستندات):

**فیلدهای تایید‌شده که Gemini قبول می‌کنه (HTTP 200):**
```
type, format, title, description, nullable, enum, maxItems, minItems,
properties, required, minProperties, maxProperties, minLength, maxLength,
pattern, example (فقط مفرد), anyOf, oneOf, allOf, propertyOrdering,
default, items, minimum, maximum
```

**فیلدهایی که Gemini رد می‌کنه (۴۰۰ با `Unknown name "X"`):**
```
additionalProperties, exclusiveMinimum, exclusiveMaximum, propertyNames,
patternProperties, const, examples (جمع — فقط مفرد پذیرفته می‌شه),
readOnly, writeOnly, deprecated, $schema, $id, $ref, $defs,
unevaluatedProperties, unevaluatedItems
```

نکته‌ی ریز مهم: `examples` (جمع) رد می‌شه ولی `example` (مفرد) قبوله — پس صرفاً حذف
کافی نیست؛ `uppercaseSchemaTypes` اولین مقدار آرایه‌ی `examples` رو به `example`
map می‌کنه تا این راهنما از دست نره.

نتیجه‌ی این تغییر در `src/nativeTranslate.js` (`GEMINI_SCHEMA_ALLOWED_KEYS`) — و چون
`anthropicTranslate.js` همین تابع مشترک رو reuse می‌کنه، فیکس خودکار به هر دو مسیر
(OpenAI و Anthropic) سرایت کرد. از این تغییر به بعد، هیچ کلید ناشناخته‌ی جدیدی
(حتی از یک نسخه‌ی آینده‌ی Claude Code) دیگه باعث ۴۰۰ نمی‌شه — فقط بی‌صدا drop می‌شه.

### ۳.۳) `/v1/messages/count_tokens`

Claude Code (و کلاینت‌های مشابه) قبل از فرستادن پیام، حجم پرامپت رو تخمین می‌زنن.
معادل بومی گوگل (`:countTokens`) شکل بدنه‌ی خاص خودش رو می‌خواد — نه `contents` ساده،
بلکه پیچیده‌شده داخل یک آبجکت `generateContentRequest`:
```json
{
  "generateContentRequest": {
    "model": "models/gemini-3.6-flash",
    "contents": [...],
    "systemInstruction": {...},
    "tools": [...]
  }
}
```
این شکل بدنه با تست زنده تایید شد (نسخه‌ی ساده‌ی بدون wrapper، توکن‌های system/tools
رو حساب نمی‌کرد). `translateAnthropicCountTokensRequest` این wrapper رو می‌سازه، با
استفاده‌ی مجدد از همون منطق ساخت prompt (`buildNativePromptParts`) که مسیر اصلی چت
هم ازش استفاده می‌کنه — بدون تکرار کد.

### ۳.۴) هشدار «auto» در کاتالوگ مدل Claude Code

غیربحرانی، ولی ارزش مستندسازی داره: نسخه‌های جدید Claude Code (v2.1.x+) یک کاتالوگ
داخلی از مدل‌های شناخته‌شده دارن که context window هرکدوم رو می‌دونن. چون `auto` یک
alias خودمونه (نه اسم واقعی یک مدل Anthropic)، Claude Code محافظه‌کارانه فرض می‌کنه
۲۰۰k توکن context داره و ممکنه زودتر از موعد auto-compact (خلاصه‌سازی خودکار
تاریخچه) بزنه.

**راه‌حل:** ست‌کردن `CLAUDE_CODE_MAX_CONTEXT_TOKENS` در `~/.claude/settings.json`
صریحاً — که هم هشدار رو می‌بنده، هم اجازه می‌ده خودت آستانه‌ی auto-compact رو دستی
کنترل کنی (مثلاً روی ۲۵۰k، اگه می‌خوای مدل زودتر از رسیدن به نقطه‌ای که کیفیتش افت
می‌کنه خلاصه‌سازی کنه).

---

## ۴) روش‌شناسی تست — چرا این‌بار جواب داد

الگوی زیر (که در `cloudflare-projects-lessons-learned.md` بخش ۴ هم مستند شده) دقیقاً
همینجا هم به کار رفت و باعث شد بدون هیچ حدس اشتباهی به پروداکشن برسیم:

1. **توابع خالص + تست واحد جدا از I/O** — `anthropicTranslate.js` کاملاً pure
   functions هستن، قابل تست با Node.js ساده، بدون نیاز به شبکه.
2. **مجهولات رو با تست زنده حل کن، نه فرض** — شکل دقیق بدنه‌ی `:countTokens`،
   فیلدهای مجاز schema، و رفتار streaming همگی با `curl` مستقیم به کلید واقعی گوگل
   تایید شدن، نه از روی مستندات.
3. **canary جدا قبل از پروداکشن** — یک Worker کاملاً مجزا (`google2anthropic`،
   `wrangler.test.toml`) با state جدا، برای تست بدون هیچ ریسکی برای ترافیک زنده.
4. **cutover گیت‌دار** — حتی بعد از تست‌های موفق، merge و دیپلوی نهایی فقط با تایید
   صریح انسانی انجام شد.
5. **تست نهایی با کلاینت واقعی، نه فقط curl** — تست‌های اولیه‌ی `claude -p` با یک
   سناریوی ساده «موفق» به نظر رسیدن، ولی وقتی خودِ کاربر با نسخه‌ی واقعی Claude Code
   و ابزارهای built-in واقعی‌ش امتحان کرد، یک کلاس کاملاً جدید از خطا (schema)
   پیدا شد. **درس: تست خودکار با یک کلاینت شبیه‌سازی‌شده هیچ‌وقت جای یک اجرای واقعی
   با نسخه‌ی واقعی کلاینت رو نمی‌گیره — خصوصاً وقتی اون کلاینت (مثل Claude Code)
   ابزارهای built-in خودش رو داره که کنترلشون دست ما نیست.**

---

## ۵) اتصال Claude Code — چک‌لیست کامل

```bash
export ANTHROPIC_BASE_URL="https://<your-worker>.workers.dev"
export ANTHROPIC_AUTH_TOKEN="<همون PROXY_TOKEN>"
export ANTHROPIC_API_KEY=""              # باید صریحاً خالی باشه
export ANTHROPIC_MODEL="auto"
export ANTHROPIC_SMALL_FAST_MODEL="fast"
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="250000"
```

نکات حیاتی:
- `ANTHROPIC_API_KEY=""` باید **صریحاً خالی** باشه، وگرنه Claude Code سعی می‌کنه با
  سابسکریپشن واقعی Anthropic لاگین کنه و صفحه‌ی انتخاب لاگین رو نشون می‌ده.
- اگه یک session قدیمی/credentials cache‌شده مزاحمت شد: `claude /logout` یا حذف
  `~/.claude/.credentials.json`.
- برای دائمی‌کردن، همین متغیرها رو داخل بخش `env` در `~/.claude/settings.json` بذار.

---

## ۶) محدودیت‌های شناخته‌شده‌ی این پل

- **stop_reason مربوط به `stop_sequence`**: Gemini معادل مستقیمی برای این‌که «کدوم
  stop sequence دقیقاً باعث توقف شد» نداره؛ همه‌چیز به `end_turn` فروکاسته می‌شه.
- **`oneOf`/`allOf` تایید شده ولی کمتر تست شدن** نسبت به `anyOf` (که مستقیماً چندبار
  در سناریوهای واقعی دیده شد). اگه رفتار غیرمنتظره دیدی، این دو مظنون اول باش.
- **حداکثر یک تماس تابع در هر chunk استریم Gemini میاد کامل**، نه تدریجی مثل
  OpenAI/Anthropic واقعی — یعنی `input_json_delta` همیشه در یک رویداد کامل می‌رسه،
  نه چند تکه. از نظر عملکردی برای هر کلاینتی که partial_json رو جمع می‌کنه قبل از
  parse، تفاوتی نداره.
- **بدون Files API عمومی و بدون prompt caching واقعی** — این‌ها قابلیت‌های جدید
  Anthropic هستن، نه صرفاً ترجمه‌ی چیز موجود، و عمداً از این فاز جدا نگه داشته شدن.

---

## ۷) مرجع سریع: کدهای خطا و استراتژی retry (مخصوص این پل)

همون قوانین کلی روتر (`cloudflare-projects-lessons-learned.md` بخش ۴.۶) اینجا هم
عیناً صدق می‌کنن — چون upstream همیشه Google‌ست، نه واقعاً Anthropic:

| کد | معنی | اقدام |
|---|---|---|
| ۴۲۹ | این کلید برای این مدل تمومه | کلید بعدی، همون مدل |
| ۵۰۲/۵۰۳/۵۰۴/۵۲۴ | خودِ مدل ناپایداره | مدل بعدی، بعد از ۳ بار پشت‌سرهم circuit breaker |
| ۴۰۰ | مشکل شکل درخواست (اغلب یعنی یک کلید schema جدید کشف شد) | fail-fast، بدون retry — و باید بررسی بشه که آیا allowlist نیاز به آپدیت داره |
| ۴۰۱/۴۰۳ | کلید نامعتبر/باطل | کلید بعدی |
