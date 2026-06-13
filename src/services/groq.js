const Groq = require('groq-sdk');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are a helpful SKU inventory assistant for a coffee bean commodity provider platform.
You ONLY answer questions related to stock availability, product information, and orders.
If asked about anything unrelated to inventory/stock, politely redirect the user back to inventory topics.
Be concise and friendly. Currency is IDR (Indonesian Rupiah) by default, with USD available on request.`;

async function askGroq(userMessage, context = '') {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + '\n\n' + context },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
  });

  return completion.choices[0].message.content;
}

module.exports = { askGroq };