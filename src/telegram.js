import { SEED_MODELS, SEED_KEYS } from "./config.js";

const TG_API = (token) => `https://api.telegram.org/bot${token}`;

// Telegram messages are capped at 4096 chars; keep a safety margin.
const CHUNK_SIZE = 3500;

export async function sendTelegramMessage(env, chatId, text) {
  const chunks = splitIntoChunks(text, CHUNK_SIZE);
  for (const chunk of chunks) {
    await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  }
}

// Like sendTelegramMessage but attaches an inline keyboard. Assumes the text
// fits in one message (true for the /priority view - a handful of models).
async function sendTelegramMessageWithKeyboard(env, chatId, text, replyMarkup) {
  const resp = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    }),
  });
  return resp.json();
}

async function editTelegramMessage(env, chatId, messageId, text, replyMarkup) {
  await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    }),
  });
}

async function answerCallbackQuery(env, callbackQueryId, text) {
  await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

/**
 * Proactively pings the owner outside of any incoming Telegram update -
 * used to alert on errors that actually reach Hermes (as opposed to ones
 * silently retried away internally). Safe to call even if Telegram isn't
 * configured at all (no-ops), and never throws.
 */
export async function sendOwnerAlert(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_CHAT_ID) return;
  try {
    await sendTelegramMessage(env, env.TELEGRAM_OWNER_CHAT_ID, text);
  } catch {
    // best effort only - alerting must never break the main request path
  }
}

function splitIntoChunks(text, size) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut <= 0) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

const HELP_TEXT = `🤖 <b>Gemini Hermes Router — Bot مدیریت</b>

این بات بدون هیچ لاگین یا رمزی فقط برای همین چت جواب می‌ده.

<b>مشاهده‌ی وضعیت</b>
/status — مصرف لحظه‌ای هر کلید روی هر مدل (rpm/rpd، cooldown)
/models — لیست مدل‌ها با اولویت و ریت‌لیمیت
/setprio &lt;name&gt; &lt;order&gt; [mode=auto|fast|stable] — تغییر مستقیم اولویت/ترتیب یک مدل
مثال: <code>/setprio gemini-4-flash 1 fast</code>
/keys — لیست کلیدها (ماسک‌شده)
/logs [تعداد] [status] — لاگ‌های اخیر، مثال: <code>/logs 20 error</code>
/stats [ساعت] — آمار تجمیعی، مثال: <code>/stats 24</code>
مثال:
<code>/addkey AQ.xxxxxxxxxxxxxxxxxxxx key-6</code>
<code>/addkey sk-or-v1-xxxxxxxxxxxx or-key-1 provider=openrouter</code>

<b>روشن/خاموش کردن</b>
/enablemodel &lt;name&gt; — /disablemodel &lt;name&gt;
/enablekey &lt;id&gt; — /disablekey &lt;id&gt;

<b>حذف</b>
/delmodel &lt;name&gt;
/delkey &lt;id&gt;

<b>سایر</b>
/seed — ثبت خودکار ۳ مدل و ۵ کلید اولیه
/help — همین راهنما

🚨 هر وقت خطایی واقعاً به Hermes برگرده (نه فقط یک retry داخلی)، همین‌جا فوراً یک پیام هشدار می‌گیری.`;

export async function handleTelegramWebhook(request, env, ctx, getStub) {
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const got = request.headers.get("x-telegram-bot-api-secret-token");
    if (got !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok");
  }

  if (update.callback_query) {
    return await handleCallbackQuery(update.callback_query, env, getStub);
  }

  const message = update.message || update.edited_message;
  if (!message || typeof message.text !== "string") return new Response("ok");

  const chatId = message.chat.id;

  // No login flow, no password - just a silent allowlist so random people
  // who somehow guess the bot username can't manage your keys/models.
  // Leave TELEGRAM_OWNER_CHAT_ID unset to allow anyone (not recommended).
  if (env.TELEGRAM_OWNER_CHAT_ID && String(chatId) !== String(env.TELEGRAM_OWNER_CHAT_ID)) {
    return new Response("ok");
  }

  const stub = getStub(env);
  const text = message.text.trim();
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.replace(/@\S+$/, "").toLowerCase();

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        await sendTelegramMessage(env, chatId, HELP_TEXT);
        break;
      case "/status":
        await sendTelegramMessage(env, chatId, await formatStatus(stub));
        break;
      case "/models":
        await sendTelegramMessage(env, chatId, await formatModels(stub));
        break;
      case "/keys":
        await sendTelegramMessage(env, chatId, await formatKeys(stub));
        break;
      case "/logs":
        await sendTelegramMessage(env, chatId, await formatLogs(stub, args));
        break;
      case "/stats":
        await sendTelegramMessage(env, chatId, await formatStats(stub, args));
        break;
      case "/addmodel":
        await sendTelegramMessage(env, chatId, await cmdAddModel(stub, args));
        break;
      case "/setprio":
        await sendTelegramMessage(env, chatId, await cmdSetPrio(stub, args));
        break;
      case "/addkey":
        await sendTelegramMessage(env, chatId, await cmdAddKey(stub, args));
        break;
      case "/delmodel":
        await sendTelegramMessage(env, chatId, await cmdDelModel(stub, args));
        break;
      case "/delkey":
        await sendTelegramMessage(env, chatId, await cmdDelKey(stub, args));
        break;
      case "/enablemodel":
        await sendTelegramMessage(env, chatId, await cmdToggleModel(stub, args, true));
        break;
      case "/disablemodel":
        await sendTelegramMessage(env, chatId, await cmdToggleModel(stub, args, false));
        break;
      case "/enablekey":
        await sendTelegramMessage(env, chatId, await cmdToggleKey(stub, args, true));
        break;
      case "/disablekey":
        await sendTelegramMessage(env, chatId, await cmdToggleKey(stub, args, false));
        break;
      case "/seed":
        await sendTelegramMessage(env, chatId, await cmdSeed(stub));
        break;
      default:
        await sendTelegramMessage(env, chatId, "دستور شناخته‌نشد. برای راهنما /help رو بفرست.");
    }
  } catch (e) {
    await sendTelegramMessage(env, chatId, `❌ خطا: ${escapeHtml(e.message || String(e))}`);
  }

  return new Response("ok");
}

// ===========================================================================
// Inline-button priority reordering
// ===========================================================================

async function buildPriorityView(stub, mode = "auto") {
  const normMode = mode.toLowerCase();
  const orderCol = normMode === "fast" ? "order_fast" : normMode === "stable" ? "order_stable" : "order_num";
  
  // Exclude non-chat kinds (tts, embedding) and sort by the current mode's column
  const models = (await stub.listModels())
    .filter((m) => !m.kind || m.kind === "chat")
    .sort((a, b) => (a[orderCol] ?? 100) - (b[orderCol] ?? 100) || a.id - b.id);

  const modePersian = normMode === "fast" ? "سریع (Fast)" : normMode === "stable" ? "پایدار (Stable)" : "خودکار (Auto)";

  let text =
    `🔀 <b>اولویت مدل‌ها در حالت: ${modePersian}</b>\n` +
    `هرچه بالاتر باشد زودتر امتحان می‌شود. برای تغییر حالت می‌توانید از این دستورها استفاده کنید:\n` +
    `• <code>/priority auto</code>\n` +
    `• <code>/priority fast</code>\n` +
    `• <code>/priority stable</code>\n\n`;

  const keyboard = [];
  models.forEach((m, i) => {
    const badge = m.enabled ? "✅" : "⛔";
    text += `${i + 1}. ${badge} ${escapeHtml(m.name)} [${escapeHtml(m.provider)}]\n`;
    keyboard.push([
      { text: i === 0 ? "▪️" : "⬆️", callback_data: i === 0 ? "noop" : `prio_up_${m.id}_${normMode}` },
      { text: `${i + 1}. ${m.name}`.slice(0, 40), callback_data: "noop" },
      {
        text: i === models.length - 1 ? "▪️" : "⬇️",
        callback_data: i === models.length - 1 ? "noop" : `prio_down_${m.id}_${normMode}`,
      },
    ]);
  });
  if (models.length === 0) text += "هیچ مدل متنی (chat) ثبت نشده است.\n";
  return { text: text.trim(), reply_markup: { inline_keyboard: keyboard } };
}

async function handleCallbackQuery(callbackQuery, env, getStub) {
  const fromId = callbackQuery.from && callbackQuery.from.id;
  if (env.TELEGRAM_OWNER_CHAT_ID && String(fromId) !== String(env.TELEGRAM_OWNER_CHAT_ID)) {
    await answerCallbackQuery(env, callbackQuery.id, "⛔ اجازه نداری");
    return new Response("ok");
  }

  const data = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const stub = getStub(env);

  if (data === "noop") {
    await answerCallbackQuery(env, callbackQuery.id);
    return new Response("ok");
  }

  const m = data.match(/^prio_(up|down)_(\d+)_([a-z]+)$/);
  if (m && chatId && messageId) {
    const [, direction, modelIdStr, mode] = m;
    try {
      const result = await stub.swapModelOrder({ modelId: Number(modelIdStr), direction, mode });
      await answerCallbackQuery(env, callbackQuery.id, result.moved ? "جابه‌جا شد ✅" : "همین‌جا ته صف/سر صفه");
      const view = await buildPriorityView(stub, mode);
      await editTelegramMessage(env, chatId, messageId, view.text, view.reply_markup);
    } catch (e) {
      await answerCallbackQuery(env, callbackQuery.id, `خطا: ${String(e.message || e).slice(0, 180)}`);
    }
    return new Response("ok");
  }

  await answerCallbackQuery(env, callbackQuery.id);
  return new Response("ok");
}

// ===========================================================================
// Formatters
// ===========================================================================

async function formatStatus(stub) {
  const s = await stub.getStatus();
  let out = `📊 <b>وضعیت سیستم</b>\nزمان سرور: ${s.server_time}\nریست سهمیه‌ی روزانه تا: ${Math.ceil(
    s.next_daily_reset_in_sec / 60
  )} دقیقه دیگر\n\n`;
  if (s.models.length === 0) out += "هیچ مدلی ثبت نشده. از /seed یا /addmodel استفاده کن.\n";
  for (const m of s.models) {
    const cb = m.circuit_breaker || {};
    const orders = m.kind === "chat" || !m.kind
      ? `(order_auto=${m.order}, order_fast=${m.order_fast ?? 100}, order_stable=${m.order_stable ?? 100})`
      : `(order=${m.order})`;
    out += `<b>${escapeHtml(m.name)}</b> [${escapeHtml(m.provider)}/${escapeHtml(m.kind || "chat")}] ${orders} ${m.enabled ? "فعال ✅" : "غیرفعال ⛔"}\nThinking پیش‌فرض: ${m.default_thinking ?? "-"}\n`;
    if (cb.unavailable) {
      out += `  ⏸ مدل موقتاً کنار گذاشته شده (${cb.fail_streak} خطای پشت‌سرهم) — ${cb.unavailable_remaining_sec}s دیگه برمی‌گرده\n`;
    }
    if (m.keys.length === 0) out += "  (کلیدی با این provider ثبت نشده)\n";
    for (const k of m.keys) {
      const icon = !k.enabled ? "⚪" : k.cooling_down ? "🔴" : "🟢";
      out += `  ${icon} ${escapeHtml(k.label || "#" + k.id)}: ${k.minute_used}/${k.minute_limit} دقیقه‌ای، ${k.day_used}/${k.day_limit} روزانه`;
      if (k.cooling_down) out += ` (cooldown ${k.cooldown_remaining_sec}s)`;
      out += "\n";
    }
    out += "\n";
  }
  return out.trim();
}

async function formatModels(stub) {
  const models = await stub.listModels();
  if (models.length === 0) return "هیچ مدلی ثبت نشده. از /seed یا /addmodel استفاده کن.";
  let out = "📦 <b>مدل‌ها</b>\n\n";
  for (const m of models.sort((a, b) => a.order_num - b.order_num)) {
    out += `${m.enabled ? "✅" : "⛔"} <b>${escapeHtml(m.name)}</b> [${escapeHtml(m.provider || "google")}/${escapeHtml(m.kind || "chat")}]\n`;
    const orders = m.kind === "chat" || !m.kind
      ? `order_auto=${m.order_num} | order_fast=${m.order_fast ?? 100} | order_stable=${m.order_stable ?? 100}`
      : `order=${m.order_num}`;
    out += `  ${orders} | rpm=${m.rpm} | rpd=${m.rpd}\n`;
    out += `  thinking_levels=${m.thinking_levels.join(",") || "(none)"} | default=${m.default_thinking ?? "-"}\n`;
    if ((m.unavailable_until || 0) > Date.now()) {
      out += `  ⏸ در cooldown مدار قطع تا ${Math.ceil((m.unavailable_until - Date.now()) / 1000)}s دیگه\n`;
    }
    out += "\n";
  }
  return out.trim();
}

async function formatKeys(stub) {
  const keys = await stub.listKeys({ reveal: false });
  if (keys.length === 0) return "هیچ کلیدی ثبت نشده. از /seed یا /addkey استفاده کن.";
  let out = "🔑 <b>کلیدها</b>\n\n";
  for (const k of keys) {
    out += `${k.enabled ? "✅" : "⛔"} #${k.id} ${escapeHtml(k.label || "-")} [${escapeHtml(k.provider || "google")}] — <code>${k.api_key}</code>\n`;
  }
  return out.trim();
}

async function formatLogs(stub, args) {
  const limit = Number(args[0]) || 20;
  const status = args[1] || null;
  const logs = await stub.getLogs({ limit, status });
  if (logs.length === 0) return "لاگی ثبت نشده.";
  let out = `📜 <b>${logs.length} لاگ اخیر</b>${status ? ` (status=${status})` : ""}\n\n`;
  for (const l of logs) {
    const t = new Date(l.ts).toISOString().slice(11, 19);
    const icon = l.status === "success" ? "✅" : "❌";
    out += `${icon} ${t} ${escapeHtml(l.model_name || "-")} / ${escapeHtml(l.key_label || "-")} — HTTP ${l.http_status ?? "-"}`;
    if (l.status === "success") {
      out += ` — tokens: ${l.total_tokens ?? "?"} — ${l.latency_ms ?? "?"}ms`;
    } else if (l.error_message) {
      out += `\n    ${escapeHtml(l.error_message.slice(0, 200))}`;
    }
    out += "\n";
  }
  return out.trim();
}

async function formatStats(stub, args) {
  const hours = Number(args[0]) || 24;
  const s = await stub.getStats({ sinceMs: hours * 3600 * 1000 });
  const t = s.totals || {};
  let out = `📈 <b>آمار ${hours} ساعت اخیر</b>\n\n`;
  out += `درخواست‌ها: ${t.requests || 0} (✅ ${t.successes || 0} / ❌ ${t.errors || 0})\n`;
  out += `توکن‌ها: prompt=${t.prompt_tokens || 0}, completion=${t.completion_tokens || 0}, total=${t.total_tokens || 0}\n`;
  out += `میانگین latency: ${t.avg_latency_ms ? Math.round(t.avg_latency_ms) + "ms" : "-"}\n\n`;
  if (s.by_model && s.by_model.length) {
    out += "<b>به‌تفکیک مدل:</b>\n";
    for (const m of s.by_model) {
      out += `  ${escapeHtml(m.model_name || "-")}: ${m.requests} req (✅${m.successes}/❌${m.errors}), ${m.total_tokens} tok\n`;
    }
  }
  return out.trim();
}

// ===========================================================================
// Mutating commands
// ===========================================================================

async function cmdAddModel(stub, args) {
  const { positional, kv } = extractKv(args);
  const [name, order, rpm, rpd, levelsCsv, defaultThinking] = positional;
  if (!name || order === undefined || rpm === undefined || rpd === undefined) {
    return (
      "فرمت درست:\n<code>/addmodel &lt;name&gt; &lt;order&gt; &lt;rpm&gt; &lt;rpd&gt; [levels_csv|none] [default] [provider=openrouter] [kind=tts|embedding]</code>\n" +
      "مثال چت:\n<code>/addmodel gemini-4-flash 4 5 20 minimal,low,medium,high high</code>\n" +
      "مثال TTS (بدون reasoning، از همون /v1/chat/completions با modalities استفاده می‌شه):\n<code>/addmodel gemini-2.5-flash-preview-tts 20 5 20 none kind=tts</code>\n" +
      "مثال embedding:\n<code>/addmodel gemini-embedding-2 1 10 100 none kind=embedding</code>"
    );
  }
  const thinking_levels =
    levelsCsv === undefined
      ? undefined
      : levelsCsv === "none"
      ? []
      : levelsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const model = await stub.addModel({
    name,
    order: Number(order),
    rpm: Number(rpm),
    rpd: Number(rpd),
    thinking_levels,
    default_thinking: defaultThinking,
    provider: kv.provider,
    kind: kv.kind,
  });
  return `✅ مدل ثبت شد: <b>${escapeHtml(model.name)}</b> [${escapeHtml(model.provider)}/${escapeHtml(model.kind)}] | order=${model.order_num} | rpm=${model.rpm} | rpd=${model.rpd}`;
}

async function cmdSetPrio(stub, args) {
  const [name, orderStr, mode = "auto"] = args;
  if (!name || !orderStr || Number.isNaN(Number(orderStr))) {
    return "فرمت درست:\n<code>/setprio &lt;name&gt; &lt;order&gt; [mode=auto|fast|stable]</code>\nمثال: <code>/setprio gemini-4-flash 1 fast</code>";
  }
  const orderVal = Number(orderStr);
  const normMode = mode.toLowerCase();
  const patch = {};
  if (normMode === "fast") patch.order_fast = orderVal;
  else if (normMode === "stable") patch.order_stable = orderVal;
  else patch.order = orderVal;

  await stub.updateModel(name, patch);
  return `✅ اولویت مدل <b>${escapeHtml(name)}</b> در حالت <b>${escapeHtml(normMode)}</b> به <b>${orderVal}</b> تغییر یافت.`;
}

async function cmdAddKey(stub, args) {
  const { positional, kv } = extractKv(args);
  const [apiKey, ...labelParts] = positional;
  if (!apiKey) return "فرمت درست:\n<code>/addkey &lt;api_key&gt; [label] [provider=openrouter]</code>";
  const label = labelParts.join(" ") || undefined;
  const key = await stub.addKey({ api_key: apiKey, label, provider: kv.provider });
  return `✅ کلید ثبت شد: id=${key.id} [${escapeHtml(key.provider)}]${key.label ? ` label=${escapeHtml(key.label)}` : ""}`;
}

// Pulls out any "key=value" tokens (e.g. "provider=openrouter") from an args
// array so free-text fields like labels can still contain normal words
// without colliding with optional keyword-style options.
function extractKv(args) {
  const positional = [];
  const kv = {};
  for (const a of args) {
    const m = a.match(/^([a-zA-Z_]+)=(.+)$/);
    if (m) kv[m[1]] = m[2];
    else positional.push(a);
  }
  return { positional, kv };
}

async function cmdDelModel(stub, args) {
  const [name] = args;
  if (!name) return "فرمت درست:\n<code>/delmodel &lt;name&gt;</code>";
  const r = await stub.deleteModel(name);
  return r.deleted ? `🗑️ مدل «${escapeHtml(name)}» حذف شد.` : `مدلی به اسم «${escapeHtml(name)}» پیدا نشد.`;
}

async function cmdDelKey(stub, args) {
  const [id] = args;
  if (!id || Number.isNaN(Number(id))) return "فرمت درست:\n<code>/delkey &lt;id&gt;</code>";
  await stub.deleteKey(Number(id));
  return `🗑️ کلید #${id} حذف شد.`;
}

async function cmdToggleModel(stub, args, enable) {
  const [name] = args;
  if (!name) return `فرمت درست:\n<code>/${enable ? "enablemodel" : "disablemodel"} &lt;name&gt;</code>`;
  try {
    await stub.updateModel(name, { enabled: enable });
    return `${enable ? "✅ فعال شد" : "⛔ غیرفعال شد"}: ${escapeHtml(name)}`;
  } catch (e) {
    return `❌ ${escapeHtml(e.message || String(e))}`;
  }
}

async function cmdToggleKey(stub, args, enable) {
  const [id] = args;
  if (!id || Number.isNaN(Number(id))) return `فرمت درست:\n<code>/${enable ? "enablekey" : "disablekey"} &lt;id&gt;</code>`;
  try {
    await stub.updateKey(Number(id), { enabled: enable });
    return `${enable ? "✅ فعال شد" : "⛔ غیرفعال شد"}: کلید #${id}`;
  } catch (e) {
    return `❌ ${escapeHtml(e.message || String(e))}`;
  }
}

async function cmdSeed(stub) {
  for (const m of SEED_MODELS) await stub.addModel(m);
  await stub.addKeysBulk(SEED_KEYS);
  return `✅ ${SEED_MODELS.length} مدل و ${SEED_KEYS.length} کلید اولیه ثبت شدند. با /status چک کن.`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
