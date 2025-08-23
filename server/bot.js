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
    month: "long",
  });

  const text =
    `✅ Подписка активирована!\n\n` +
    `Доступ открыт до *${dateStr}*.\n\n` +
    `Если что-то пойдёт не так — открывай мини-апп, там всё под рукой.`;

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

// Запуск long polling
bot.start();
