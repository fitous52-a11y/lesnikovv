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

  try {
    const { message, history = [] } = req.body;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: message }
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