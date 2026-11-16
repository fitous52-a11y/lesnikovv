const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

// Authorization Key из личного кабинета GigaChat (строка в base64)
const GIGACHAT_AUTH_KEY = process.env.GIGACHAT_API_KEY;
// Для физлиц: GIGACHAT_API_PERS. Для бизнеса: GIGACHAT_API_B2B или GIGACHAT_API_CORP
const GIGACHAT_SCOPE = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const GIGACHAT_API_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

// Сертификат Минцифры не знает Node.js, поэтому отключаем проверку
// только для запросов к GigaChat
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// --- Защита от спама: не более 30 сообщений в час с одного IP ---
// Счётчики живут в памяти экземпляра функции и обнуляются при холодном
// старте — это защита от массового спама, а не точный учёт.
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 час
const rateBuckets = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || '';
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  // Чистим устаревшие записи, чтобы память не разрасталась
  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.start > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  return bucket.count <= RATE_LIMIT_MAX;
}

// Сколько сообщений истории принимаем от клиента (защита от раздувания расхода)
const HISTORY_MAX_MESSAGES = 10;
const MESSAGE_MAX_CHARS = 2000;

const SYSTEM_PROMPT = 'Ты — Иван, продавец-консультант питомника «ЛесниковВ». Ты общаешься с покупателями в чате на сайте lesnikovv.ru. Твоя цель — помочь клиенту выбрать и купить сеянцы или саженцы хвойных пород и довести его до заявки. О компании: основан в 2005 году, руководитель Котынов Вячеслав Евгеньевич. Адрес: Нижегородская область, Кулебакский район, с. Теплово, ул. Новая, дом 12. Телефон: +7 902 783-59-36. Товары: Сеянцы сосны ЗКС (11р), сосна открытая (3р), ель европейская ЗКС (12р), саженцы сосны ЗКС (50р и 150р), ель европейская С3 (180р). Правила: отвечай коротко, дружелюбно, в конце задавай один уточняющий вопрос.';

// Кэш токена, чтобы не запрашивать его при каждом сообщении
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Берём токен из кэша, если он ещё действует (с запасом в минуту)
  if (cachedToken && Date.now() < tokenExpiresAt - 60 * 1000) {
    return cachedToken;
  }

  const response = await axios.post(
    OAUTH_URL,
    'scope=' + GIGACHAT_SCOPE,
    {
      headers: {
        'Authorization': 'Basic ' + GIGACHAT_AUTH_KEY,
        'RqUID': crypto.randomUUID(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      httpsAgent
    }
  );

  cachedToken = response.data.access_token;
  // expires_at приходит в миллисекундах
  tokenExpiresAt = response.data.expires_at || (Date.now() + 25 * 60 * 1000);
  return cachedToken;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // Проверяем лимит ДО любых платных операций
  if (!checkRateLimit(getClientIp(req))) {
    return res.status(429).json({
      message: 'Вы отправили очень много сообщений за последний час. Пожалуйста, загляните чуть позже или позвоните нам: +7 902 783-59-36 — ответим на все вопросы!'
    });
  }

  try {
    const { message, history = [] } = req.body;

    // Берём только последние сообщения истории и режем слишком длинные,
    // чтобы клиент не мог раздуть расход токенов
    const safeHistory = (Array.isArray(history) ? history : [])
      .slice(-HISTORY_MAX_MESSAGES)
      .map(m => ({
        role: m && m.role === 'assistant' ? 'assistant' : 'user',
        content: String((m && m.content) || '').slice(0, MESSAGE_MAX_CHARS)
      }));

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...safeHistory,
      { role: 'user', content: String(message || '').slice(0, MESSAGE_MAX_CHARS) }
    ];

    const token = await getAccessToken();

    const response = await axios.post(
      GIGACHAT_API_URL,
      {
        model: 'GigaChat',
        messages: messages,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent
      }
    );

    const aiReply = response.data.choices[0].message.content;

    return res.status(200).json({ message: aiReply });

  } catch (error) {
    // Если токен устарел или недействителен, сбрасываем кэш
    if (error.response && error.response.status === 401) {
      cachedToken = null;
    }
    const details = error.response
      ? error.response.status + ' ' + JSON.stringify(error.response.data)
      : error.message;
    console.error('Error:', details);
    return res.status(500).json({
      message: 'Ой, что-то связь с питомником прервалась. Попробуйте позже или напишите в WhatsApp: +7 902 783-59-36'
    });
  }
};
