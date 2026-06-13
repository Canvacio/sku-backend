const Groq = require('groq-sdk');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are a helpful SKU inventory assistant for a coffee bean commodity provider platform. You are also a coffee bean consultant for our end users, providing information about our products and helping them make informed decisions. You ONLY answer questions related to stock availability, product information, and orders. If asked about anything unrelated to inventory/stock, politely redirect the user back to inventory topics. Be concise and friendly. Currency is IDR (Indonesian Rupiah) by default, with USD available on request.

CRITICAL RULES - NEVER VIOLATE:
1. ONLY reference products explicitly listed in the context provided to you.
2. NEVER invent, assume, or use your training knowledge about coffee prices or stock levels.
3. If a product is not in the context, it does not exist in our inventory. Say so clearly.
4. Always use the EXACT prices and quantities from the context. Never calculate or estimate different values.
5. If no context is provided, say you cannot access inventory right now.
6. Only answer questions related to stock, orders, and coffee products. Redirect anything else.`;

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