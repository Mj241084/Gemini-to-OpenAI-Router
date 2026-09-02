# Gemini ⇄ Hermes Router (Cloudflare Worker)

یک Cloudflare Worker که به عنوان یک **base URL سازگار با OpenAI** جلوی Google AI Studio
(مدل‌های Gemini) می‌شیند، بین چند مدل و چند API key به‌صورت هوشمند چرخش (rotation) و
fallback انجام می‌ده، ریت‌لیمیت هرکدوم رو جدا پیگیری می‌کنه، و همه‌چیز رو لاگ می‌گیره —
بدون این‌که در جریان درخواست‌های Hermes Agent وقفه‌ای ایجاد کنه.

---

## ۱) معماری خیلی خلاصه

```
Hermes Agent  --(OpenAI-compatible request)-->  این Worker  --(کلید انتخاب‌شده)-->  Google AI Studio
                                                     │
                                                     ▼
                                          Durable Object (SQLite)
                                    مدل‌ها / کلیدها / ریت‌لیمیت / لاگ‌ها
```

- **Worker** (`src/index.js`): درخواست Hermes رو می‌گیره، مدل/کلید مناسب رو از Durable
  Object می‌پرسه، درخواست رو به `generativelanguage.googleapis.com` فوروارد می‌کنه، و بر
  اساس نتیجه (موفق / ۴۲۹ / ۵۰۳ / ...) تصمیم می‌گیره کلید یا مدل رو عوض کنه یا نه.
- **Durable Object** (`src/routerDO.js`): تنها جایی‌ست که state واقعی نگه‌داری می‌شه —
  لیست مدل‌ها (با اولویت order، rpm، rpd، جدول thinking level)، لیست API keyها، شمارنده‌ی
  مصرف هر (کلید, مدل) در دقیقه/روز جاری، cooldown بعد از خطا، و جدول لاگ‌ها. چون روی پلن
  رایگان Cloudflare فقط Durable Object با backend مبتنی بر **SQLite** (یعنی
  `new_sqlite_classes`) مجاز است، دقیقاً همین رو در `wrangler.toml` تنظیم کرده‌ایم.

نکته‌ی مهم: به این خاطر که تمام state داخل یک Durable Object نگه‌داری می‌شه (نه در چند
Worker پراکنده)، انتخاب کلید/مدل و به‌روزرسانی شمارنده‌ها **atomic و بدون race condition**
هستند — چون هر Durable Object در هر لحظه فقط یک درخواست را واقعاً پردازش می‌کند.

---

## ۲) آیا با CPU wall / Wall-clock limit پلن رایگان امکان‌پذیره؟

بله، و دلیلش این‌جاست (طبق مستندات فعلی Cloudflare):

| بخش | محدودیت پلن رایگان | چرا مشکلی پیش نمی‌آد |
|---|---|---|
| **Worker خودِ fetch handler** | ۱۰ میلی‌ثانیه CPU time به‌ازای هر درخواست | زمان `await fetch(...)` (چه به Durable Object، چه به Google) **جزو CPU time حساب نمی‌شه** — فقط زمان واقعی اجرای JS (parse/stringify JSON، چند تا مقایسه) حساب می‌شه که در حد چند صدم میلی‌ثانیه‌ست. |
| **Durable Object (SQLite-backed)** | به‌صورت جدا **۳۰ ثانیه** CPU time پیش‌فرض (قابل افزایش تا ۵ دقیقه) — حتی روی پلن رایگان، چون DO از قوانین CPU متفاوتی نسبت به Worker معمولی پیروی می‌کنه | تمام کوئری‌های SQLite (که سنگین‌ترین بخش منطق rate-limit است) داخل همین DO اجرا می‌شن، پس بودجه‌ی خیلی بزرگ‌تری دارن. |
| **درخواست‌های روزانه** | ۱۰۰,۰۰۰ درخواست/روز روی Worker + ۱۰۰,۰۰۰ درخواست/روز روی Durable Object | برای مصرف شخصی (rpm=5 روی چند مدل) خیلی خیلی بیشتر از نیاز واقعیه. |
| **نوشتن/خواندن ردیف در SQLite** | ~۱۰۰K نوشتن/روز، ~۱.۲۵M خواندن/روز (پلن رایگان) | هر درخواست موفق فقط ۱-۲ نوشتن (شمارنده + لاگ) مصرف می‌کنه؛ برای این حجم استفاده مشکلی ایجاد نمی‌شه. |
| **Wall-clock کلی** | برای Workers محدودیت سخت مشخصی منتشر نشده؛ محدودیت واقعی زمان انتظار fetch است | چون پاسخ Gemini (حتی با thinking) معمولاً در چند ثانیه برمی‌گرده و استریم هم پشتیبانی می‌شه، مشکلی پیش نمی‌آد. برای احتیاط، هر تلاش به Google با timeout ۳۰ ثانیه محدود شده (`UPSTREAM_TIMEOUT_MS` در `src/config.js`). |

جمع‌بندی: طراحی «Worker سبک + منطق سنگین داخل Durable Object» دقیقاً برای دور زدن محدودیت
۱۰ میلی‌ثانیه‌ای پلن رایگان است و روی این پروژه کاملاً جواب می‌ده.

---

## ۳) ساختار فایل‌ها

```
gemini-hermes-router/
├── wrangler.toml         # تنظیمات Cloudflare (نام Worker، binding، migration)
├── package.json
├── .dev.vars.example     # نمونه‌ی فایل سکرت برای dev محلی
└── src/
    ├── index.js          # روتینگ اصلی: /v1/chat/completions ، /v1/models ، /admin/*
    ├── routerDO.js        # کلاس Durable Object + اسکیمای SQLite
    ├── config.js         # ثابت‌ها + داده‌ی seed (۳ مدل و ۵ کلیدی که فرستادی)
    └── util.js           # احراز هویت، محاسبه‌ی بازه‌ی روز به وقت ایران، هلسپرهای HTTP
```

---

## ۴) پیش‌نیازها

- Node.js نسخه‌ی ۱۸ به بالا (ترجیحاً ۲۰+)
- یک اکانت Cloudflare (پلن Free کافیه)
- دسترسی به اجرای `npx wrangler ...` (نیازی به نصب سراسری نیست)

---

## ۵) نصب و Deploy با Wrangler — قدم‌به‌قدم

```bash
# ۱. وارد پوشه‌ی پروژه شو
cd gemini-hermes-router

# ۲. وابستگی‌ها رو نصب کن (wrangler)
npm install

# ۳. لاگین به اکانت Cloudflare
npx wrangler login

# ۴. تعیین توکن‌های امنیتی (هرکدوم رو با یک رشته‌ی تصادفی و بلند جایگزین کن)
npx wrangler secret put PROXY_TOKEN
# > مقداری که Hermes باید به‌عنوان API key بفرسته، مثلاً یک UUID یا رشته‌ی ۴۰ کاراکتری تصادفی

npx wrangler secret put ADMIN_TOKEN
# > مقداری که خودت برای مدیریت مدل/کلید و مشاهده‌ی آمار استفاده می‌کنی

# ۵. Deploy
npx wrangler deploy
```

بعد از `deploy`، آدرسی شبیه این می‌گیری:

```
https://gemini-hermes-router.<your-subdomain>.workers.dev
```

این آدرس، همراه با `/v1` در انتهاش، همون **base URL** ای هست که به Hermes می‌دی.

> برای توسعه‌ی محلی: فایل `.dev.vars.example` رو کپی کن به `.dev.vars` و مقادیر
> `PROXY_TOKEN` / `ADMIN_TOKEN` رو داخلش بنویس، بعد `npm run dev` رو بزن. **این فایل
> نباید commit بشه** (در `.gitignore` هم هست).

---

## ۶) اضافه‌کردن مدل‌ها و API keyها

چون Durable Object SQLite فقط از **داخل خود Durable Object** قابل دسترسیه (برخلاف D1 که
با `wrangler d1 execute` از بیرون قابل کوئری‌زدنه)، نمی‌شه مستقیماً با CLI به دیتابیسش
وصل شد. برای همین دو راه گذاشته‌ام:

### راه ۱ (پیشنهادی): از طریق Admin API — همون «کوئری‌ها»ی درخواستی، به‌شکل HTTP

**راحت‌ترین راه برای شروع:** یک اندپوینت seed گذاشته‌ام که همون ۳ مدل و ۵ کلیدی که
فرستادی رو یک‌جا وارد می‌کنه:

```bash
curl -X POST https://<your-worker>.workers.dev/admin/seed \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

این معادل اجرای این «کوئری‌ها»ست:

**افزودن یک مدل** (`POST /admin/models`):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "gemini-3.5-flash",
    "order": 1,
    "rpm": 5,
    "rpd": 20,
    "thinking_levels": ["minimal", "low", "medium", "high"],
    "default_thinking": "high",
    "enabled": true
  }'
```
همین درخواست رو برای `gemini-3.6-flash` (order=2) و `gemini-3.7-flash` (order=3) هم
تکرار کن. عدد `order` کوچیک‌تر = اولویت بالاتر، دقیقاً همون‌طور که خواسته بودی.

> اگر در آینده مدل جدیدی اضافه شد که سطح‌های thinking متفاوتی داره (مثلاً یکی
> `minimal/low/high` بدون `medium`)، فقط کافیه آرایه‌ی `thinking_levels` رو برای همون مدل
> عوض کنی؛ آخرین عضو آرایه به‌صورت پیش‌فرض به‌عنوان «بالاترین سطح» انتخاب می‌شه، مگر
> این‌که `default_thinking` رو صریح ست کنی.

**ویرایش یک مدل** (`PATCH /admin/models/:name`):
```bash
curl -X PATCH https://<your-worker>.workers.dev/admin/models/gemini-3.5-flash \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
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

**افزودن یک API key** (`POST /admin/keys`):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/keys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{ "api_key": "AQ.XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "label": "key-6" }'
```

**افزودن چند کلید با هم (bulk):**
```bash
curl -X POST https://<your-worker>.workers.dev/admin/keys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "keys": [
      { "api_key": "AQ.KEY_A...", "label": "key-6" },
      { "api_key": "AQ.KEY_B...", "label": "key-7" }
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
# برای دیدن مقدار کامل کلید (نه ماسک‌شده) به انتهای URL اضافه کن: ?reveal=1
```

### راه ۲: کوئری خام SQL (برای کسی که ترجیحش SQL مستقیمه)

یک اندپوینت passthrough گذاشته‌ام که مستقیماً روی SQLite داخل Durable Object اجرا می‌شه:

```bash
curl -X POST https://<your-worker>.workers.dev/admin/query \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "INSERT INTO models (name, order_num, rpm, rpd, thinking_levels, default_thinking, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    "params": ["gemini-3.5-flash", 1, 5, 20, "[\"minimal\",\"low\",\"medium\",\"high\"]", "high", 1, 1735000000000, 1735000000000]
  }'
```

و برای کلید:

```bash
curl -X POST https://<your-worker>.workers.dev/admin/query \
  -H "Authorization: Bearer ***" \
  -H "Content-Type: application/json" \
  -d '{
    "sql": "INSERT INTO api_keys (api_key, label, enabled, created_at) VALUES (?,?,?,?)",
    "params": ["AQ.YOUR_KEY_HERE", "key-1", 1, 1735000000000]
  }'
```

⚠️ **این اندپوینت خیلی قدرتمنده** (هر SQL دلخواهی رو اجرا می‌کنه، از جمله `DROP TABLE`).
فقط پشت `ADMIN_TOKEN` محافظت می‌شه؛ توکن رو جایی درز نده. برای استفاده‌ی روزمره، راه ۱
(Admin API ساختاریافته) امن‌تر و توصیه‌شده است چون فرمت داده (JSON آرایه‌ی
`thinking_levels`، مقدار پیش‌فرض order و...) رو خودش validate می‌کنه.

اسکیمای کامل جدول‌ها (برای مرجع، در `src/routerDO.js` هم هست):

```sql
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  order_num INTEGER NOT NULL DEFAULT 100,
  rpm INTEGER NOT NULL,
  rpd INTEGER NOT NULL,
  thinking_levels TEXT NOT NULL DEFAULT '["minimal","low","medium","high"]',
  default_thinking TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key TEXT UNIQUE NOT NULL,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
```

---

## ۷) راه‌اندازی روی Hermes Agent

Hermes از یک provider به اسم **Custom endpoint** پشتیبانی می‌کنه که دقیقاً برای همین کاره.

### روش تعاملی (پیشنهادی)
```bash
hermes model
# → گزینه "Custom endpoint" رو انتخاب کن
# → Base URL: https://<your-worker>.workers.dev/v1
# → API key:   همون مقداری که برای PROXY_TOKEN گذاشتی
# → Model:     auto
```
بعد از تنظیم، با `hermes doctor` صحت اتصال رو چک کن.

### روش دستی (ویرایش کانفیگ)
داخل `~/.hermes/config.yaml` (یا هر جایی که پروفایل موردنظرت تعریف شده):

```yaml
model:
  default: auto
  provider: custom
  base_url: https://<your-worker>.workers.dev/v1
  api_key: ${HERMES_GATEWAY_TOKEN}     # یا مستقیم مقدار PROXY_TOKEN
  context_length: 200000               # طبق پنجره‌ی متن واقعی مدلی که استفاده می‌کنی، در مستندات Google چک کن
```

و توکن رو هم می‌تونی داخل `~/.hermes/.env` بذاری:
```
HERMES_GATEWAY_TOKEN=<همون مقدار PROXY_TOKEN>
```

### درباره‌ی فیلد `model`
- اگه مقدار `model` رو **`auto`** بذاری (پیشنهاد می‌شه)، Worker همیشه از بالاترین اولویت
  (کوچیک‌ترین `order`) شروع می‌کنه و طبق در دسترس بودن ریت‌لیمیت، خودش تصمیم می‌گیره.
- اگه یک اسم مدل مشخص مثل `gemini-3.6-flash` بذاری، Worker از **همون مدل** شروع می‌کنه
  ولی اگه اون مدل هم exhausted/۵۰۳ بشه، طبق همون منطق fallback به مدل‌های بعدی (طبق
  اولویت `order`) می‌ره — یعنی حتی این حالت هم fallback رو از دست نمی‌ده.

اگه بخوای در یک درخواست خاص از سمت Hermes سطح thinking رو خودت مشخص کنی (به‌جای
پیش‌فرض بالاترین سطح)، کافیه در بدنه‌ی درخواست فیلد `reasoning_effort` رو بفرستی (مثلاً
`"reasoning_effort": "low"`) — Worker وقتی این فیلد رو ببینه، دیگه دست به تنظیم پیش‌فرض
نمی‌زنه و همون مقدار رو عیناً پاس می‌ده. این‌که Hermes چطور یک فیلد سفارشی به بدنه‌ی
درخواست اضافه می‌کنه، به تنظیمات خودِ Hermes بستگی داره؛ مستندات فعلی Hermes رو برای این
مورد چک کن.

---

## ۸) منطق rate-limit، فالبک و thinking level (خلاصه‌ی دقیق رفتار)

1. برای هر (کلید, مدل) دو شمارنده نگه‌داری می‌شه: مصرفِ **این دقیقه** و مصرفِ **این روز**.
2. بازه‌ی روزانه دقیقاً همون‌طور که خواستی، **ساعت ۱۲:۳۰ ظهر به وقت ایران** ریست می‌شه
   (نه نیمه‌شب) — پیاده‌سازی در `getIranDayWindow()` در `src/util.js`.
3. قبل از فوروارد هر درخواست، Worker از Durable Object می‌پرسه: «بین مدل‌های فعال (به
   ترتیب اولویت `order`)، کدوم (کلید, مدل)ای الان هم به rpm و هم به rpd نرسیده و
   cooldown هم نداره؟» و از بین گزینه‌های موجود، کلیدی که بیشترین حاشیه‌ی مصرف روزانه/
   دقیقه‌ای رو داره انتخاب می‌کنه (برای پخش یکنواخت بار بین کلیدها).
4. اگه پاسخ گوگل **۴۲۹** باشه → همون کلید برای همون مدل موقتاً کنار گذاشته می‌شه (تا شروع
   دقیقه‌ی بعد، یا اگه پیام خطا نشون بده مشکل سهمیه‌ی روزانه‌ست، تا ریست ۱۲:۳۰ فردا) و
   Worker با **کلید بعدی همون مدل** دوباره تلاش می‌کنه.
5. اگه پاسخ گوگل **۵۰۳/۵۰۲/۵۰۴** باشه (یا اصلاً network error) → کل مدل کنار گذاشته
   می‌شه و Worker به **مدل بعدی طبق اولویت** می‌ره (نه فقط کلید بعدی).
6. اگه پاسخ **۴۰۰** باشه → چون معمولاً یعنی خودِ درخواست (مثلاً thinking level نامعتبر
   برای اون مدل خاص) مشکل داره، Worker بلافاصله همون خطا رو به Hermes برمی‌گردونه و
   دیگه با کلید/مدل دیگه امتحان نمی‌کنه (امتحان دوباره چیزی رو حل نمی‌کنه).
7. **در هیچ‌کدوم از حالت‌های خطا، شمارنده‌ی مصرفِ موفق افزایش پیدا نمی‌کنه** — فقط
   درخواست‌های واقعاً موفق (HTTP 200) روی شمارنده‌ی rpm/rpd حساب می‌شن؛ دقیقاً طبق
   خواسته‌ات.
8. اگه هیچ (کلید, مدل)ی در دسترس نباشه، Worker یک خطای `429` استاندارد به Hermes
   برمی‌گردونه با تخمین زمان باقی‌مونده تا ریست بعدی.
9. برای هر مدل یک جدول `thinking_levels` نگه‌داری می‌شه (پیش‌فرض:
   `["minimal","low","medium","high"]`). اگه Hermes مقدار `reasoning_effort` یا
   `extra_body.google.thinking_config` رو نفرسته باشه، Worker خودش بالاترین سطح
   (آخرین عضو آرایه، پیش‌فرض `"high"`) رو ست می‌کنه — دقیقاً طبق مکانیزم مپینگ رسمی
   OpenAI-compatibility در مستندات Gemini (فیلد استاندارد `reasoning_effort` به‌صورت
   خودکار به `thinking_level` مپ می‌شه).
10. تمام این وقایع (موفق/ناموفق، توکن مصرفی، تاخیر، پیام خطا) به‌صورت **async** با
    `ctx.waitUntil(...)` لاگ می‌شن، یعنی پاسخ به Hermes معطل نوشتن لاگ نمی‌مونه.

---

## ۹) مانیتورینگ

**وضعیت لحظه‌ای هر کلید/مدل:**
```bash
curl https://<your-worker>.workers.dev/admin/status -H "Authorization: Bearer <ADMIN_TOKEN>"
```
خروجی شامل مصرف دقیقه‌ای/روزانه‌ی هر کلید روی هر مدل، این‌که در cooldown هست یا نه، و
چند ثانیه تا ریست بعدی مونده.

**لاگ‌های اخیر:**
```bash
curl "https://<your-worker>.workers.dev/admin/logs?limit=50" -H "Authorization: Bearer <ADMIN_TOKEN>"
curl "https://<your-worker>.workers.dev/admin/logs?status=error&limit=50" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**آمار تجمیعی (پیش‌فرض ۲۴ ساعت اخیر):**
```bash
curl "https://<your-worker>.workers.dev/admin/stats?hours=24" -H "Authorization: Bearer <ADMIN_TOKEN>"
```
شامل تعداد کل درخواست‌ها، موفق/خطا، مجموع توکن مصرفی (prompt/completion/total) به‌صورت
کلی و به‌تفکیک هر مدل.

**لاگ زنده‌ی خودِ Worker (برای دیباگ):**
```bash
npx wrangler tail
```

---

## ۱۰) نکات امنیتی

- `PROXY_TOKEN` و `ADMIN_TOKEN` رو حتماً با `wrangler secret put` ست کن، نه در
  `wrangler.toml` (که ممکنه commit بشه).
- اندپوینت‌های `/admin/*` بدون `ADMIN_TOKEN` صحیح، ۴۰۱ برمی‌گردونن — این تنها لایه‌ی
  دفاعیه، پس توکن رو محرمانه نگه‌دار.
- `/admin/query` معادل دسترسی کامل به دیتابیسه؛ فقط برای خودت (نه برای Hermes) استفاده
  کن.
- کلیدهای واقعی AI Studio هیچ‌وقت در پاسخ‌های عمومی (`/admin/keys` بدون `?reveal=1`)
  کامل نمایش داده نمی‌شن؛ فقط چند کاراکتر اول/آخر نشون داده می‌شه.

---

## ۱۱) محدودیت‌های شناخته‌شده

- شمارش توکن برای پاسخ‌های **استریم‌شده** (`stream: true`) به‌صورت best-effort انجام
  می‌شه (با خوندن موازی از یک کپی از استریم)؛ اگه گوگل فیلد `usage` رو در چانک آخر
  استریم برنگردونه، آن‌جا `prompt_tokens`/`completion_tokens` در لاگ `null` ثبت می‌شه
  ولی خودِ پاسخ به Hermes بدون هیچ تاخیر یا اختلالی جریان پیدا می‌کنه.
- بازه‌ی ریست روزانه (۱۲:۳۰ ظهر ایران) دقیقاً طبق درخواست خودت پیاده‌سازی شده؛ اگه بعداً
  متوجه شدی که سهمیه‌ی واقعی گوگل با ساعت متفاوتی ریست می‌شه، فقط کافیه در
  `src/util.js` تابع `getIranDayWindow` رو ویرایش کنی.
- روی خطای ۴۰۰، Worker عمداً retry نمی‌کنه (چون معمولاً یعنی خودِ بدنه‌ی درخواست مشکل
  داره)، ولی همچنان کامل در `/admin/logs` ثبت می‌شه تا بفهمی دقیقاً چی پس زده شده.
- تنها اندپوینت `/v1/chat/completions` (و `/v1/models` برای discovery) پیاده‌سازی شده؛
  اگه Hermes یا نسخه‌ای که استفاده می‌کنی به endpoint دیگه‌ای (مثل `/v1/completions`
  قدیمی) نیاز داشت، باید در `src/index.js` اضافه بشه.

---

## ۱۲) رفع خطای «missing a thought_signature» (ریشه‌یابی کامل)

اگه در میانه‌ی یک مکالمه‌ی چندمرحله‌ای با ابزار (مثلاً بعد از این‌که Hermes چند فایل رو
خوند) به این خطا خوردی:

```
HTTP 400: Function call ... is missing a thought_signature in functionCall parts.
```

**دلیل** (طبق مستندات رسمی گوگل، هم صفحه‌ی
[OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) و هم صفحه‌ی
[thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)):
مدل‌های Gemini 3 روی هر `function call` یک امضای رمزنگاری‌شده (`thought_signature`)
می‌ذارن که باید دقیقاً همون‌طور که دریافت شده، در تماس بعدی برگردونده بشه — این امضا در
فرمت OpenAI-compatible داخل یک فیلد غیراستاندارد زندگی می‌کنه:

```json
"tool_calls": [{
  "extra_content": { "google": { "thought_signature": "..." } },
  "function": { "name": "...", "arguments": "..." },
  "id": "...", "type": "function"
}]
```

چون Hermes یک کلاینت استاندارد OpenAI است، این فیلد `extra_content` رو نمی‌شناسه و وقتی
تاریخچه‌ی پیام‌ها رو برای نوبت بعدی بازسازی می‌کنه، این فیلد گم می‌شه — دقیقاً همون‌چیزی
که در گزارش‌های مشابه از VS Code Copilot، Open WebUI و چند کلاینت دیگه هم دیده شده؛ یعنی
یک ناسازگاری شناخته‌شده بین کلاینت‌های استاندارد OpenAI و Gemini 3 است.

**اصلاح انجام‌شده:** چون این worker بین Hermes و گوگل نشسته، بهترین‌جا برای رفعش همینه.
تابع `ensureThoughtSignatures()` در `src/index.js` قبل از فوروارد هر درخواست، تاریخچه‌ی
پیام‌ها رو می‌گرده و هر `tool_call` ای که امضای واقعی نداره رو با مقدار placeholder رسمی
گوگل (`context_engineering_is_the_way_to_go`، طبق FAQ همون صفحه‌ی مستندات) پر می‌کنه —
که اعتبارسنجی رو دور می‌زنه بدون این‌که به کیفیت پاسخ آسیب بزنه. اگه امضای واقعی از
جایی حفظ شده باشه، دست‌نخورده باقی می‌مونه (چیزی overwrite نمی‌شه).

نیازی به کار اضافه از سمتت نیست — این اصلاح در همین آپدیت کد پیاده شده و برای هر سه مدل
اعمال می‌شه؛ فقط دوباره `wrangler deploy` بزن.

---

## ۱۳) بات تلگرام — مدیریت بدون هیچ لاگین

یک بات تلگرام اضافه شده که همون کارهای `/admin/*` رو از داخل چت انجام می‌ده، بدون رمز یا
مرحله‌ی ورود اضافه — فقط باید مطمئن بشیم غریبه‌ها نمی‌تونن باتت رو پیدا کنن و ازش
سوءاستفاده کنن، برای همین یک **لیست سفید ساکت** (silent allowlist) بر پایه‌ی `chat_id`
خودت گذاشتم؛ هیچ رمز/دستوری از سمت تو لازم نیست، بات فقط برای همون چتی که تنظیم کردی
جواب می‌ده و به بقیه اصلاً پاسخی نمی‌ده (نه حتی خطا).

### راه‌اندازی

**۱. ساخت بات:** به [@BotFather](https://t.me/BotFather) پیام بده، `/newbot` رو بزن و
توکن (چیزی شبیه `123456:ABC-DEF...`) رو بگیر.

**۲. پیدا کردن chat_id خودت:** به [@userinfobot](https://t.me/userinfobot) پیام بده تا
عدد `Id` رو بهت بده.

**۳. ست کردن secretها:**
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# مقدار: توکنی که از BotFather گرفتی

npx wrangler secret put TELEGRAM_OWNER_CHAT_ID
# مقدار: همون chat_id که از userinfobot گرفتی

# اختیاری ولی پیشنهادشده (یک لایه‌ی امنیتی نامرئی دیگه، کاری با تجربه‌ی
# چت‌کردنت نداره - فقط جلوی جعل درخواست وبهوک رو می‌گیره):
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# مقدار: یک رشته‌ی تصادفی دلخواه
```

**۴. Deploy و ثبت webhook:**
```bash
npx wrangler deploy

curl "https://<your-worker>.workers.dev/admin/telegram/setup" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**۵. شروع کن:** توی تلگرام به باتت `/start` بزن — بلافاصله آموزش کامل همه‌ی دستورات رو
برات می‌فرسته.

### تغییر اولویت مدل‌ها با دکمه‌های اینلاین

دستور `/priority` رو بزن — لیست مدل‌ها با دکمه‌های ⬆️/⬇️ نشون داده می‌شه. هر بار که
دکمه رو بزنی، مدل با همسایه‌ی بالا/پایینش جابه‌جا می‌شه و همون پیام آپدیت می‌شه (بدون
پیام جدید). اولین مدل دکمه‌ی ⬆️ نداره (▪️ نشون داده می‌شه)، آخرین مدل هم ⬇️ نداره —
یعنی نمی‌تونی از مرز لیست خارج بشی.

### هشدار خودکار برای خطاهای واقعی

اگه یک خطا واقعاً به Hermes برگرده (نه یک retry داخلی که خودش حل شده) — یعنی دقیقاً
همون لحظه‌ای که کارت متوقف می‌شه — بلافاصله یک پیام 🚨 در همین چت دریافت می‌کنی، شامل
مدل/کلید درگیر و متن خطای گوگل. این شامل این موارد می‌شه:
- خطای ۴۰۰ (fail-fast، معمولاً یعنی مشکل در خودِ درخواست)
- زمانی که همه‌ی مدل‌ها/کلیدها exhausted شدن (۴۲۹ به Hermes)
- زمانی که تمام تلاش‌های fallback (`MAX_ATTEMPTS`) ناموفق موند

خطاهای ۴۲۹/۵۰۳/۵۰۲/۵۰۴/۴۰۱/۴۰۳ که با تعویض کلید/مدل **حل می‌شن**، هشدار نمی‌فرستن —
چون کارت مختل نشده، فقط داخلی retry شده.

### دستورات (نمونه‌ی کامل ثبت مدل/کلید از طریق بات)

```
/status
/models
/keys
/logs 20 error
/stats 24

/addmodel gemini-3.5-flash 1 5 20 minimal,low,medium,high high
/addmodel gemini-3.6-flash 2 5 20 minimal,low,medium,high high
/addmodel gemini-3.7-flash 3 5 20 minimal,low,medium,high high

/addkey AQ.YOUR_KEY_1 key-1
/addkey AQ.YOUR_KEY_2 key-2

/disablemodel gemini-3.7-flash
/enablekey 2
/delkey 5
/delmodel gemini-3.7-flash

/seed   # همون کار /admin/seed رو می‌کنه، برای شروع سریع
```

پاسخ هر دستور همون‌جا توی چت میاد؛ برای لیست کامل هر وقت خواستی `/help` رو بزن.

---

## ۱۵) کارایی: انتخاب هوشمندتر کلید + مدار قطع خودکار برای مدل‌های ناپایدار

اگه گاهی حس می‌کنی جواب‌گیری کند شده، دو تا اصلاح اضافه شد:

**انتخاب کلید LRU:** قبلاً کلیدها فقط بر اساس مصرف روزانه/دقیقه‌ای مرتب می‌شدن. حالا اگه
چند کلید مصرف مساوی داشته باشن، کلیدی که **دیرتر از همه استفاده شده** انتخاب می‌شه — یک
چرخش عادلانه‌تر (round-robin) بین کلیدها.

**مدار قطع خودکار (circuit breaker) برای ۵۰۲/۵۰۳/۵۰۴:** قبلاً وقتی یک مدل ۵۰۳ می‌داد، آن
درخواست به مدل بعدی می‌رفت ولی **درخواست بعدی دوباره از همون مدل معیوب شروع می‌شد** — یعنی
تا وقتی مدل واقعاً برگرده، هر درخواست یک رفت‌وبرگشت شبکه‌ی اضافه (و کند) رو تحمل می‌کرد. حالا:

- هر مدل یک شمارنده‌ی «خطای پشت‌سرهم» داره.
- بعد از **۳ بار پشت‌سرهم** خطای ۵۰۲/۵۰۳/۵۰۴ (یا خطای شبکه)، مدل به مدت **۶۰ ثانیه** کاملاً
  از چرخه‌ی انتخاب کنار گذاشته می‌شه — درخواست‌های بعدی حتی امتحانش هم نمی‌کنن، مستقیم
  می‌رن سراغ مدل بعدیِ اولویت.
- به محض یک پاسخ موفق (از هر کلیدی)، شمارنده صفر می‌شه و مدل بلافاصله برمی‌گرده به چرخه.
- این آستانه‌ها (`MODEL_FAIL_THRESHOLD = 3`, `MODEL_UNAVAILABLE_COOLDOWN_MS = 60000`) در
  `src/config.js` قابل تغییرن اگه خواستی سخت‌گیرانه‌تر/آسان‌گیرانه‌تر بشه.

می‌تونی وضعیتش رو با `/status` در بات تلگرام یا `GET /admin/status` ببینی — اگه مدلی در
cooldown مدار قطع باشه، به‌صورت `⏸ مدل موقتاً کنار گذاشته شده` نشون داده می‌شه.

**مهاجرت بدون درد سر:** این تغییرات نیاز به ستون‌های جدید در دیتابیس داشتن. چون
Durable Object تو از قبل با داده‌ی واقعی در حال اجراست، یک مهاجرت خودکار (`ALTER TABLE`)
در راه‌اندازی worker اضافه شده که این ستون‌ها رو بدون از دست رفتن هیچ داده‌ای اضافه
می‌کنه — فقط کافیه دوباره `wrangler deploy` بزنی، نیازی به seed مجدد یا پاک کردن چیزی نیست.

---

## ۱۶) افزودن مدل‌های جدید

```bash
# gemini-3.5-flash-lite — کاملاً امن، ۴ سطح thinking کامل رو پشتیبانی می‌کنه
/addmodel gemini-3.5-flash-lite 4 5 20 minimal,low,medium,high minimal

# gemma-4-31b-it و gemma-4-26b-a4b-it — واقعی هستن، ولی دو نکته:
#  ۱) thinking فقط دو حالته: "high" (روشن) یا "minimal" (خاموش) - نه ۴ سطح مثل Gemini
#  ۲) نتونستم در مستندات تأیید کنم این مدل‌ها از همون endpoint سازگار با OpenAI که
#     worker استفاده می‌کنه (v1beta/openai/chat/completions) جواب می‌دن یا نه -
#     نمونه‌های رسمی گوگل فقط API بومی (generateContent) رو نشون می‌دن.
#     پیشنهاد: با rpm کم امتحان کن؛ اگه 404 گرفتی یعنی از این مسیر در دسترس نیست.
/addmodel gemma-4-31b-it 5 3 20 minimal,high high
/addmodel gemma-4-26b-a4b-it 6 3 20 minimal,high high
```

(از طریق بات تلگرام هم دقیقاً همین دستورات رو می‌تونی بفرستی.)

---

## ۱۷) افزودن OpenRouter به‌عنوان یک provider دوم

**جواب کوتاه: بله، امکان‌پذیره و می‌ارزه** — چون معماری فعلی (اولویت‌بندی مدل‌ها با
`order` + fallback خودکار) دقیقاً برای همین ساخته شده؛ اضافه‌کردن OpenRouter فقط یعنی
مدل‌های OpenRouter رو با `order` بالاتر (اولویت پایین‌تر) ثبت کنی تا وقتی همه‌ی
مدل‌های Google تمام شدن، به‌صورت خودکار fallback بره روی OpenRouter — بدون تغییر منطق
اصلی.

### چیزی که اضافه شد
- هر مدل و هر کلید حالا یک فیلد `provider` داره (`google` یا `openrouter`، پیش‌فرض `google`).
- کلیدها فقط با مدل‌های **همون provider** جفت می‌شن (یک کلید Google هیچ‌وقت با مدل
  OpenRouter امتحان نمی‌شه و برعکس).
- آدرس upstream بر اساس provider انتخاب می‌شه (`generativelanguage.googleapis.com` یا
  `openrouter.ai/api/v1/chat/completions`) — احراز هویت هر دو یکسانه
  (`Authorization: Bearer <key>`).
- تعمیر `thought_signature` (بخش ۱۲) فقط برای provider=google اجرا می‌شه؛ برای
  OpenRouter دست‌نخورده می‌مونه.
- اگه `thinking_levels` یک مدل رو خالی (`[]`) بذاری، worker اصلاً `reasoning`/
  `reasoning_effort` بهش تزریق نمی‌کنه — برای مدل‌های OpenRouter که reasoning رو
  پشتیبانی نمی‌کنن، این جلوی خطای احتمالی رو می‌گیره.
- **فرمت reasoning بر اساس provider خودکار عوض می‌شه:** برای Google، فیلد تخت
  `reasoning_effort` فرستاده می‌شه (همون‌طور که همیشه بوده). برای OpenRouter، از فرمت
  فعلی و درست‌شون یعنی آبجکت تو در تو `"reasoning": {"effort": "..."}` استفاده می‌شه، و
  اگه Hermes به‌جاش فیلد تخت قدیمی رو فرستاده باشه، خودکار به فرمت درست تبدیل می‌شه
  (چون OpenRouter اگه هر دو فرمت رو هم‌زمان ببینه، با ۴۰۰ رد می‌کنه).

### نکته‌ی مهم درباره‌ی مستندات OpenRouter
دقت کن: OpenRouter صدها مدل داره و هرکدوم ممکنه سطح‌های reasoning متفاوتی قبول کنن
(بعضی‌ها فقط `low/medium/high`، بعضی‌ها مثل GLM 5.2 فقط `high/xhigh`، بعضی‌ها اصلاً
reasoning ندارن). خوشبختانه OpenRouter خودش اگه سطحی که فرستادی رو مدل پشتیبانی نکنه،
به نزدیک‌ترین سطح معتبر map می‌کنه — یعنی حتی اگه دقیق ندونی، خطای سخت نمی‌گیری. برای
هر مدل جدید، `thinking_levels` رو مطابق چیزی که در openrouter.ai/models برای همون مدل
نوشته تنظیم کن (یا برای مدل‌های بدون reasoning، خالی بذار).

### نمونه‌ی عملی: افزودن GLM 5.2 و Gemma 4 26B A4B

**GLM 5.2** (`z-ai/glm-5.2`) — مدل reasoning قوی Z.ai برای کدنویسی و کارهای agentic،
پنجره‌ی متن ۱M توکن. **پولیه** (نه رایگان) — حدود $1.40 ورودی / $4.40 خروجی به ازای هر
میلیون توکن؛ فقط دو سطح reasoning قبول می‌کنه: `high` و `xhigh` (که `xhigh` معادل
بالاترین/عمیق‌ترین reasoning است):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "name": "z-ai/glm-5.2",
    "provider": "openrouter",
    "order": 10,
    "rpm": 10,
    "rpd": 100,
    "thinking_levels": ["high", "xhigh"],
    "default_thinking": "xhigh"
  }'
```
یا از بات: `/addmodel z-ai/glm-5.2 10 10 100 high,xhigh xhigh provider=openrouter`

⚠️ چون پولیه، `rpd` رو طوری تنظیم کن که با بودجه‌ات جور دربیاد؛ مصرف واقعی توکن رو با
`/stats` یا `GET /admin/stats` رصد کن.

**Gemma 4 26B A4B** (`google/gemma-4-26b-a4b-it:free`) — نسخه‌ی رایگان مدل MoE جدید
گوگل روی OpenRouter (نه از طریق Google AI Studio مستقیم — همینه که مشکل عدم‌قطعیت
سازگاری با endpoint گوگل که قبلاً گفته بودم رو کلاً دور می‌زنه). reasoning استاندارد
OpenRouter رو پشتیبانی می‌کنه:
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{
    "name": "google/gemma-4-26b-a4b-it:free",
    "provider": "openrouter",
    "order": 11,
    "rpm": 15,
    "rpd": 40,
    "thinking_levels": ["low", "medium", "high"],
    "default_thinking": "high"
  }'
```
یا از بات: `/addmodel google/gemma-4-26b-a4b-it:free 11 15 40 low,medium,high high provider=openrouter`

⚠️ **نکته‌ی مهم درباره‌ی مدل‌های `:free`:** محدودیت واقعی OpenRouter برای مدل‌های رایگان
(۲۰ درخواست در دقیقه، و ۵۰ یا ۱۰۰۰ در روز بسته به این‌که حداقل ۱۰ دلار شارژ خریده باشی
یا نه) **در سطح کل اکانتت روی همه‌ی مدل‌های `:free` مشترکه**، نه جداگانه به‌ازای هر مدل.
یعنی اگه چند مدل رایگان OpenRouter هم‌زمان اضافه کنی، `rpm`/`rpd` ای که این‌جا تعریف
می‌کنی فقط برای ردیابی داخلی *این* worker است؛ سقف واقعی رو خودِ OpenRouter (مشترک بین
همه‌ی مدل‌های `:free` آن کلید) تحمیل می‌کنه. برای جلوگیری از سردرگمی، مقادیر rpm/rpd رو
محافظه‌کارانه بذار (مثلاً کمتر از ۲۰/۵۰) و اگه ۴۲۹ زیاد گرفتی، منطق موجود worker خودش
کلید رو موقتاً کنار می‌ذاره.

### راه‌اندازی

**۱. کلید بگیر:** به [openrouter.ai](https://openrouter.ai/keys) برو، یک API key بساز
(معمولاً با پیشوند `sk-or-v1-...`).

**۲. کلید رو با provider درست ثبت کن:**
```bash
curl -X POST https://<your-worker>.workers.dev/admin/keys \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "api_key": "sk-or-v1-xxxxxxxxxxxx", "label": "or-key-1", "provider": "openrouter" }'
```
یا از بات: `/addkey sk-or-v1-xxxxxxxxxxxx or-key-1 provider=openrouter`

**۳. یک مدل OpenRouter رو با اولویت پایین‌تر (order بزرگ‌تر) از مدل‌های Google اضافه کن**
تا فقط وقتی همه‌ی Gemini exhausted شدن، fallback بهش برسه:
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
یا از بات: `/addmodel meta-llama/llama-3.3-70b-instruct:free 9 20 200 none provider=openrouter`

**۴. (اختیاری) هدرهای attribution:** OpenRouter پیشنهاد می‌ده هدرهای `HTTP-Referer` و
`X-Title` رو بفرستی (برای رتبه‌بندی و شناسایی اپلیکیشنت در داشبوردشون):
```bash
npx wrangler secret put OPENROUTER_SITE_URL   # مثلاً https://github.com/you/your-repo
npx wrangler secret put OPENROUTER_SITE_NAME  # مثلاً "My Hermes Router"
```

از این به بعد، اگه همه‌ی کلیدهای Google روی هر سه مدل Gemini تمام بشن یا ۵۰۳ مکرر بدن،
worker به‌طور خودکار (بدون هیچ تغییری در Hermes) به مدل OpenRouter fallback می‌کنه.

---

## ۱۹) پشتیبانی از TTS و Embeddings (برای پروژه‌ی ایجنت شخصی)

برای این‌که پروژه‌ی ایجنت جدید (تلگرام‌بات شخصی) بتونه همون‌طور که خواستی همه‌چیز رو از
همین یک endpoint بگیره، دو قابلیت جدید اضافه شد: یک فیلد `kind` روی هر مدل، و یک
اندپوینت `/v1/embeddings`.

### فیلد `kind`
هر مدل حالا یکی از این سه مقدار رو داره: `chat` (پیش‌فرض)، `tts`، `embedding`. این فیلد
تعیین می‌کنه هر مدل توی کدوم زنجیره‌ی fallback شرکت می‌کنه — یک درخواست TTS **هیچ‌وقت**
حتی روی خطا به یک مدل چت نمی‌ره و برعکس، چون هر endpoint فقط بین مدل‌های هم‌kind خودش
انتخاب می‌کنه. این دقیقاً همون مشکلی رو که خودت پیش‌بینی کرده بودی (ترتیب/حذف از چرخه)
حل می‌کنه، بدون نیاز به بازی کردن با `order`.

### TTS از همون `/v1/chat/completions`
نیازی به endpoint جدا نیست — مدل‌های TTS جمنای از همون مسیر همیشگی جواب می‌دن، فقط با
`modalities` و `audio` در بدنه‌ی درخواست. Worker خودش تشخیص می‌ده (`modalities` شامل
`"audio"` باشه) و زنجیره‌ی fallback رو محدود به مدل‌های `kind=tts` می‌کنه:
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
پاسخ، صدا رو به‌صورت base64 در `choices[0].message.audio.data` برمی‌گردونه.

ثبت مدل TTS (حتماً `thinking_levels` رو خالی بذار چون reasoning برای TTS معنی نداره):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "name": "gemini-2.5-flash-preview-tts", "kind": "tts", "order": 1, "rpm": 5, "rpd": 20, "thinking_levels": [] }'
```
یا از بات: `/addmodel gemini-2.5-flash-preview-tts 1 5 20 none kind=tts`

### `/v1/embeddings` (endpoint جدید)
```bash
curl -X POST https://<your-worker>.workers.dev/v1/embeddings \
  -H "Authorization: Bearer <PROXY_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "model": "auto", "input": "متنی که باید امبد بشه", "dimensions": 768 }'
```
خروجی به شکل استاندارد OpenAI-embeddings برمی‌گرده: `{"data":[{"embedding":[...],"index":0}],...}`.

**یک نکته‌ی فنی مهم:** این endpoint عمداً از لایه‌ی سازگار با OpenAI گوگل (`/v1beta/openai/embeddings`)
استفاده *نمی‌کنه*. طبق گزارش‌های موجود، پارامتر استاندارد `dimensions` روی اون لایه برای
مدل‌های Gemini نادیده گرفته می‌شه — یعنی ممکنه بی‌سروصدا بردار ۳۰۷۲بعدی بگیری به‌جای
۷۶۸بعدی که خواستی، و این دقیقاً همون چیزیه که می‌تونه Vectorize رو بی‌سروصدا خراب کنه
(چون Vectorize یک بعد ثابت برای هر index می‌خواد). برای همین این endpoint مستقیم به API
بومی گوگل (`:embedContent` / `:batchEmbedContents`) وصل می‌شه که پارامتر `output_dimensionality`
رو مطمئناً رعایت می‌کنه، و جواب رو به فرمت آشنای OpenAI برات بازسازی می‌کنه — یعنی هم
قابلیت اطمینان بیشتر داری، هم چرخش کلید/فال‌بک همیشگی رو حفظ می‌کنی.

ثبت مدل embedding (عدد rpm/rpd زیر فقط یک نقطه‌ی شروع محافظه‌کارانه‌ست؛ چون سهمیه‌ی
واقعی رایگان `gemini-embedding-2` رو با قطعیت پیدا نکردم، بعد از چند روز مصرف واقعی با
`/admin/stats` یا `/stats` تنظیمش کن):
```bash
curl -X POST https://<your-worker>.workers.dev/admin/models \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
  -d '{ "name": "gemini-embedding-2", "kind": "embedding", "order": 1, "rpm": 10, "rpd": 100, "thinking_levels": [] }'
```
یا از بات: `/addmodel gemini-embedding-2 1 10 100 none kind=embedding`

---

## ۲۰) خلاصه‌ی env vars / secrets

| نام | نوع | توضیح |
|---|---|---|
| `PROXY_TOKEN` | secret | توکنی که Hermes باید به‌عنوان `Authorization: Bearer ...` بفرسته |
| `ADMIN_TOKEN` | secret | توکن مدیریت `/admin/*` (و ثبت خودکار وبهوک تلگرام) |
| `TELEGRAM_BOT_TOKEN` | secret | توکن باتی که از BotFather گرفتی |
| `TELEGRAM_OWNER_CHAT_ID` | secret | chat_id خودت؛ بدون این، هر کسی که بات رو پیدا کنه می‌تونه ازش استفاده کنه |
| `TELEGRAM_WEBHOOK_SECRET` | secret (اختیاری) | جلوگیری از جعل درخواست وبهوک؛ تاثیری روی تجربه‌ی چت نداره |
| `OPENROUTER_SITE_URL` | secret (اختیاری) | برای هدر `HTTP-Referer` وقتی از provider=openrouter استفاده می‌کنی |
| `OPENROUTER_SITE_NAME` | secret (اختیاری) | برای هدر `X-Title` وقتی از provider=openrouter استفاده می‌کنی |
| `DISPLAY_TIMEZONE` | var (غیرحساس) | فقط جنبه‌ی نمایشی دارد؛ منطق واقعی ریست در کد است |

موفق باشی! اگه خواستی مدل جدیدی (مثلاً `gemini-4-flash` در آینده) اضافه کنی، فقط با
همون الگوی بخش ۶ یک `POST /admin/models` جدید با `order` مناسب بزن — نیازی به redeploy
کردن Worker نیست.
