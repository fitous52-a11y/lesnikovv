const axios = require('axios');

const GIGACHAT_API_KEY = process.env.GIGACHAT_API_KEY;
const GIGACHAT_API_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

const SYSTEM_PROMPT = 'Ты — Иван, продавец-консультант питомника «ЛесниковВ». Ты общаешься с покупателями в чате на сайте lesnikovv.ru. Твоя цель — помочь клиенту выбрать и купить сеянцы или саженцы хвойных пород и довести его до заявки. О компании: основан в 2005 году, руководитель Котынов Вячеслав Евгеньевич. Адрес: Нижегородская область, Кулебакский район, с. Теплово, ул. Новая, дом 12. Телефон: +7 902 783-59-36. Товары: Сеянцы сосны ЗКС (11р), сосна открытая (3р), ель европейская ЗКС (12р), саженцы сосны ЗКС (50р и 150р), ель европейская С3 (180р). Правила: отвечай коротко, дружелюбно, в конце задавай один уточняющий вопрос.';

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

    const response = await axios.post(
      GIGACHAT_API_URL,
      {
        model: 'GigaChat',
        messages: messages,
        temperature: 0.7,
      },
      {
        headers: {
          'Authorization': 'Bearer ' + GIGACHAT_API_KEY,
          'Content-Type': 'application/json'
        },
      }
    );

    const aiReply = response.data.choices[0].message.content;

    return res.status(200).json({ message: aiReply });

  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ 
      message: 'Ой, что-то связь с питомником прервалась. Попробуйте позже или напишите в WhatsApp: +7 902 783-59-36' 
    });
  }
};