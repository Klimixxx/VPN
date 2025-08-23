// bot.js
import "dotenv/config";
import { Bot } from "grammy";

// Инициализация бота токеном из переменных окружения
export const bot = new Bot(process.env.BOT_TOKEN);

// URL мини-аппа (можно задать через ENV MINI_APP_URL)
export const MINI_APP_URL =
  process.env.MINI_APP_URL || "https://ss-miniapp-frontend.vercel.app";

// Общая клавиатура для открытия мини-аппа
function openAppKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🚀 Открыть мини-апп", web_app: { url: MINI_APP_URL } }],
    ],
  };
}

/**
 * Уведомление: подписка активирована
 * @param {number|string} userId - Telegram ID пользователя
 * @param {string|Date} untilISO - Дата окончания подписки (ISO или Date)
 */
export async function notifySubActivated(userId, untilISO) {
  const until = new Date(untilISO);
  const dateStr = until.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const text =
    `✅ Подписка активирована!\n\n` +
    `Подписка активна до *${dateStr}*.\n\n` +
    `Теперь ваш сервер снова доступен вам! Перейдите в приложение V2Box и подключитесь к VPN`;

  await bot.api.sendMessage(userId, text, {
    parse_mode: "Markdown",
    reply_markup: openAppKeyboard(),
  });
}


/**
 * Уведомление: подписка скоро заканчивается (за 3 дня / за 1 день)
 * @param {number|string} userId - Telegram ID пользователя
 * @param {number|string} daysLeft - Сколько дней осталось (ожидаем 3 или 1)
 */
export async function notifySubExpiring(userId, daysLeft) {
  const n = Number(daysLeft); // критично привести к числу

  let headline, cta;
  if (n === 3) {
    headline = "⏳ До окончания подписки осталось 3 дня";
    cta = "Продли сейчас, чтобы не терять доступ.";
  } else if (n === 1) {
    headline = "⏰ Подписка заканчивается завтра";
    cta = "Успей продлить, чтобы не потерять доступ завтра.";
  } else {
    // запасной вариант, если когда-нибудь будешь слать за другое количество дней
    headline = "⏳ Подписка скоро заканчивается";
    cta = "Продли доступ в мини-аппе, чтобы не потерять соединение.";
  }

  const text =
    `*${headline}*\n\n` +
    `${cta}\n\n` +
    `Открой мини-апп, выбери удобный срок и оплати в пару кликов.`;

  await bot.api.sendMessage(userId, text, {
    parse_mode: "Markdown",
    reply_markup: openAppKeyboard(),
  });
}

// 3) Сообщение: подписка уже закончилась
export async function notifySubExpired(userId) {
  const text =
    `❌ Подписка закончилась.\n\n` +
    `Чтобы продолжить пользоваться VPN без ограничений, активируйте новую подписку в мини-приложении. ` +
    `Это займёт минуту.`;

  await bot.api.sendMessage(userId, text, {
    parse_mode: "Markdown",
    reply_markup: openAppKeyboard(),
  });
}


// Команда /start — приветствие + кнопка открытия мини-аппа
bot.command("start", async (ctx) => {
  const first = ctx.from?.first_name ?? "друг";
  const text =
    `Привет, ${first}! 👋\n\n` +
    `Это наш VPN мини-апп.\n\n` +
    `✨ Новым пользователям — *30 дней бесплатно*.\n\n` +
    `Нажми кнопку ниже, чтобы открыть приложение.`;

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: openAppKeyboard(),
  });
});

// 1) Подтверждаем оплату (обязательно), иначе Telegram отменит платёж
bot.on("pre_checkout_query", async (ctx) => {
  try {
    await ctx.answerPreCheckoutQuery(true);
  } catch (e) {
    console.error("[pre_checkout_query]", e?.description || e?.message || e);
  }
});

// 2) Успешная оплата Stars → активируем подписку через backend
bot.on("message:successful_payment", async (ctx) => {
  try {
    const sp = ctx.message.successful_payment;
    const payload = sp.invoice_payload || ""; // вида: "plan=1m;userId=123"
    const p = Object.fromEntries(
      payload.split(";").map(s => s.split("=").map(x => (x || "").trim()))
    );
    const plan = p.plan || "1m";
    const userId = Number(p.userId || ctx.from.id);

    // Дергаем наш backend, который активирует подписку
    const api = process.env.API_URL; // добавь переменную окружения на Render
    if (api) {
      await fetch(api + "/api/pay/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-From-Bot": "1" },
        body: JSON.stringify({ userId, plan })
      });
    }

    await ctx.reply("✅ Платёж получен! Подписка активирована. Откройте мини-приложение и подключитесь к VPN.");
  } catch (e) {
    console.error("[successful_payment]", e?.description || e?.message || e);
  }
});


// Сначала снимаем webhook (важно для деплоя/рестартов), потом запускаем long polling
try {
  await bot.api.deleteWebhook({ drop_pending_updates: true });
} catch (e) {
  console.warn('deleteWebhook warn:', e?.description || e?.message || e);
}

bot.start({ onStart: () => console.log('Bot started (long polling)') })
  .catch((e) => {
    // Если вдруг race-condition и уже есть активный getUpdates — не валим процесс
    if (String(e?.description || e).includes('terminated by other getUpdates')) {
      console.warn('Bot start warning: another getUpdates in progress, will keep API running');
    } else {
      throw e; // любые другие ошибки — пусть падают, чтобы мы их увидели в логах
    }
  });

