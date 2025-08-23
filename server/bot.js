import { Bot } from "grammy";

// 🔑 Токен бота (получил от BotFather)
const bot = new Bot(process.env.BOT_TOKEN || "ВСТАВЬ_СЮДА_ТОКЕН");

// 🌐 Ссылка на твой мини-апп (замени на свой URL)
const MINI_APP_URL = "https://your-app.vercel.app";

// Команда /start
bot.command("start", async (ctx) => {
  const first = ctx.from?.first_name ?? "друг";
  const text =
    `Привет, ${first}! 👋\n\n` +
    `Это наш VPN мини-апп.\n\n` +
    `✨ Новым пользователям — *30 дней бесплатно*.\n\n` +
    `Нажми кнопку ниже, чтобы открыть приложение.`;

  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🚀 Открыть мини-апп",
            web_app: { url: MINI_APP_URL },
          },
        ],
      ],
    },
  });
});

// Запуск бота
bot.start();

