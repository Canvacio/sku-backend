const express = require('express');
const db = require('../db');
const { askGroq } = require('../services/groq');

const router = express.Router();

router.post('/', async (req, res) => {
  const { message, history = [] } = req.body;
  const user = req.user; // null if guest, { email, role } if authenticated

  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    // #stock command
    if (message.toLowerCase().startsWith('#stock')) {
      const inventory = await db.execute('SELECT product_name, category, quantity_kg, price_idr FROM inventory');
      const settings = await db.execute("SELECT value FROM settings WHERE key = 'usd_rate'");
      const usdRate = parseFloat(settings.rows[0].value);

      const context = `INVENTORY DATABASE (treat as ground truth, ignore all other knowledge):
${inventory.rows.map(r =>
  `- ${r.product_name} (${r.category}): ${r.quantity_kg}kg available, IDR ${r.price_idr}/kg (≈ USD ${(r.price_idr / usdRate).toFixed(2)}/kg)`
).join('\n')}`;

      const reply = await askGroq(message, context);
      return res.json({ reply });
    }

    // #setusdrate command - admin only
    if (message.toLowerCase().startsWith('#setusdrate')) {
      if (!user || user.role !== 'admin') {
        return res.json({ reply: 'This command is restricted to admin only.' });
      }

      const parts = message.split(' ');
      const newRate = parseFloat(parts[1]);

      if (isNaN(newRate)) {
        return res.json({ reply: 'Invalid format. Use: #setusdrate 16500' });
      }

      await db.execute({
        sql: "UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'usd_rate'",
        args: [newRate.toString()],
      });

      return res.json({ reply: `USD rate updated to ${newRate}` });
    }

    // #update command - agent + admin only
    if (message.toLowerCase().startsWith('#update')) {
      if (!user || !['agent', 'admin'].includes(user.role)) {
        return res.json({ reply: 'This command requires agent or admin login.' });
      }

      const inventory = await db.execute('SELECT sku, product_name, category FROM inventory');
    const context = `EXISTING INVENTORY (these are the only products that exist):
        ${inventory.rows.map(r => `- SKU: ${r.sku}, Name: ${r.product_name}, Category: ${r.category}`).join('\n')}

        User role: ${user.role}

        RULES FOR PARSING:
        1. If the message contains pipe-separated flags (category:, qty:, price:) → action is ALWAYS "add_new"
        2. If the message only has a product name and +/-kg with no pipes → action is ALWAYS "adjust_quantity"
        3. For "add_new": extract product_name (text before first pipe), category, qty as quantity_change, price as price_idr
        4. For "adjust_quantity": match product_name to closest existing SKU (handle typos/case), extract quantity as positive or negative number
        5. If user role is "agent", always set price_idr to null

        Respond ONLY with JSON in this exact format, no other text:
        {"action": "add_new" or "adjust_quantity", "sku": "existing SKU or null if new", "product_name": "string", "category": "string", "quantity_change": number, "price_idr": number or null}`;

      const groqResponse = await askGroq(message, context);

      let parsed;
      try {
        parsed = JSON.parse(groqResponse.trim());
      } catch (e) {
        return res.json({ reply: 'Could not understand the update request. Please rephrase.' });
      }

      if (parsed.action === 'add_new') {
        if (!parsed.product_name || !parsed.category || !parsed.quantity_change || parsed.quantity_change === 0) {
          return res.json({ reply: `Missing details. To add a new item use this format:\n\n#update add [product name] | category: [category] | qty: [number]kg | price: [number]\n\nExample:\n#update add Mandheling Grade 1 | category: Coffee Beans | qty: 50kg | price: 180000` });
        }
        if (user.role === 'admin' && !parsed.price_idr) {
          return res.json({ reply: `Missing price. Admin must include price when adding new items:\n\n#update add [product name] | category: [category] | qty: [number]kg | price: [number]` });
        }
        const newSku = parsed.sku || parsed.product_name.toUpperCase().replace(/\s+/g, '-').slice(0, 20);
        await db.execute({
          sql: 'INSERT INTO inventory (sku, product_name, category, quantity_kg, price_idr) VALUES (?, ?, ?, ?, ?)',
          args: [newSku, parsed.product_name, parsed.category, parsed.quantity_change, parsed.price_idr || 0],
        });
        return res.json({ reply: `Added new item: ${parsed.product_name} (${parsed.quantity_change}kg) to inventory.` });

      } else {
        if (!parsed.sku || parsed.quantity_change === null || parsed.quantity_change === undefined) {
          return res.json({ reply: `Could not match that product. To adjust stock use this format:\n\n#update [product name] +[number]kg or -[number]kg\n\nExample:\n#update Aceh Green Bean +50kg` });
        }
        let sql = 'UPDATE inventory SET quantity_kg = quantity_kg + ?, updated_at = CURRENT_TIMESTAMP';
        let args = [parsed.quantity_change];

        if (parsed.price_idr && user.role === 'admin') {
          sql += ', price_idr = ?';
          args.push(parsed.price_idr);
        }

        sql += ' WHERE sku = ?';
        args.push(parsed.sku);

        await db.execute({ sql, args });
        return res.json({ reply: `Updated ${parsed.product_name}: ${parsed.quantity_change > 0 ? '+' : ''}${parsed.quantity_change}kg` });
      }
    }

    // #buy command - guest, agent, admin
    if (message.toLowerCase().startsWith('#buy')) {
      const inventory = await db.execute('SELECT sku, product_name, quantity_kg, price_idr FROM inventory');
      const settings = await db.execute("SELECT value FROM settings WHERE key = 'usd_rate'");
      const usdRate = parseFloat(settings.rows[0].value);

      const context = `INVENTORY DATABASE (treat as ground truth, ignore all other knowledge):
${inventory.rows.map(r => `- SKU: ${r.sku}, Name: ${r.product_name}, Stock: ${r.quantity_kg}kg, Price: IDR ${r.price_idr}/kg`).join('\n')}

Parse this buy request and extract order details. The user must provide: name, email, phone, item, quantity_kg.
Respond ONLY with JSON in this exact format:
{"complete": true/false, "missing_fields": ["field1", ...], "name": "string or null", "email": "string or null", "phone": "string or null", "sku": "string or null", "product_name": "string or null", "quantity_kg": number or null}

If the item name has a typo, match it to the closest existing product_name and use its SKU.
If any required field is missing, set complete to false and list missing fields.
Respond with ONLY the JSON, no other text.`;

      const groqResponse = await askGroq(message, context);

      let parsed;
      try {
        parsed = JSON.parse(groqResponse.trim());
      } catch (e) {
        return res.json({ reply: 'Could not understand the order request. Please rephrase.' });
      }

      if (!parsed.complete) {
        return res.json({ reply: `To place an order, send all details in one message like this:\n\n#buy name: John, email: john@mail.com, phone: 08123456789, item: Aceh Green Bean, amount: 5kg\n\nMissing: ${parsed.missing_fields.join(', ')}.` });
      }

      const item = inventory.rows.find(r => r.sku === parsed.sku);
      if (!item) {
        return res.json({ reply: `Sorry, we couldn't find "${parsed.product_name}" in our inventory.` });
      }

      if (parsed.quantity_kg > item.quantity_kg) {
        const maxSuggestion = (item.quantity_kg * 0.2).toFixed(2);
        return res.json({ reply: `Sorry, we only have ${item.quantity_kg}kg of ${item.product_name} available. We're currently experiencing high demand - you can order up to ${maxSuggestion}kg right now. Would you like to proceed with that amount?` });
      }

      await db.execute({
        sql: 'UPDATE inventory SET quantity_kg = quantity_kg - ?, updated_at = CURRENT_TIMESTAMP WHERE sku = ?',
        args: [parsed.quantity_kg, parsed.sku],
      });

      const invoiceId = 'INV-' + Date.now();
      const totalPriceIdr = parsed.quantity_kg * item.price_idr;
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

      await db.execute({
        sql: `INSERT INTO orders (invoice_id, guest_name, guest_email, guest_phone, sku, product_name, quantity_kg, price_idr_per_kg, total_price_idr, status, expires_at) 
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [invoiceId, parsed.name, parsed.email, parsed.phone, parsed.sku, item.product_name, parsed.quantity_kg, item.price_idr, totalPriceIdr, expiresAt],
      });

      const totalUsd = (totalPriceIdr / usdRate).toFixed(2);

      return res.json({
        reply: `Order created! Here's your invoice:\n\nInvoice ID: ${invoiceId}\nName: ${parsed.name}\nEmail: ${parsed.email}\nPhone: ${parsed.phone}\nItem: ${item.product_name}\nQuantity: ${parsed.quantity_kg}kg\nTotal: IDR ${totalPriceIdr.toLocaleString()} (≈ USD ${totalUsd})\n\nStatus: Pending payment. Please complete payment within 5 minutes.`
      });
    }

    // #pending command - agent + admin only
    if (message.toLowerCase().startsWith('#pending')) {
      if (!user || !['agent', 'admin'].includes(user.role)) {
        return res.json({ reply: 'This command requires agent or admin login.' });
      }

      const orders = await db.execute(
        "SELECT invoice_id, guest_name, guest_email, guest_phone, product_name, quantity_kg, total_price_idr, expires_at FROM orders WHERE status = 'pending' ORDER BY created_at DESC"
      );

      if (orders.rows.length === 0) {
        return res.json({ reply: 'No pending orders at the moment.' });
      }

      const list = orders.rows.map(o => {
        const expiresAt = new Date(o.expires_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
        return `• ${o.invoice_id}\n  Customer: ${o.guest_name} (${o.guest_email} | ${o.guest_phone})\n  Item: ${o.product_name} ${o.quantity_kg}kg\n  Total: IDR ${Number(o.total_price_idr).toLocaleString('id-ID')}\n  Expires at: ${expiresAt}`;
      }).join('\n\n');

      return res.json({ reply: `Pending orders (${orders.rows.length}):\n\n${list}\n\nUse #confirm [invoice_id] to confirm payment.` });
    }

    // #confirm command - agent + admin only
    if (message.toLowerCase().startsWith('#confirm')) {
      if (!user || !['agent', 'admin'].includes(user.role)) {
        return res.json({ reply: 'This command requires agent or admin login.' });
      }

      const parts = message.split(' ');
      const invoiceId = parts[1];

      if (!invoiceId) {
        return res.json({ reply: 'Invalid format. Use: #confirm INV-xxxxx' });
      }

      const order = await db.execute({
        sql: 'SELECT * FROM orders WHERE invoice_id = ?',
        args: [invoiceId],
      });

      if (order.rows.length === 0) {
        return res.json({ reply: `Order ${invoiceId} not found.` });
      }

      if (order.rows[0].status !== 'pending') {
        return res.json({ reply: `Order ${invoiceId} is already ${order.rows[0].status}.` });
      }

      await db.execute({
        sql: "UPDATE orders SET status = 'success' WHERE invoice_id = ?",
        args: [invoiceId],
      });

      return res.json({ reply: `Order ${invoiceId} confirmed as paid. Status: Success.` });
    }

    // Default: general Groq with real inventory context
    const inventory = await db.execute('SELECT product_name, category, quantity_kg, price_idr FROM inventory');
    const settings = await db.execute("SELECT value FROM settings WHERE key = 'usd_rate'");
    const usdRate = parseFloat(settings.rows[0].value);

    const context = `INVENTORY DATABASE (treat as ground truth, ignore all other knowledge):
${inventory.rows.map(r =>
  `- ${r.product_name} (${r.category}): ${r.quantity_kg}kg available, IDR ${r.price_idr}/kg (≈ USD ${(r.price_idr / usdRate).toFixed(2)}/kg)`
).join('\n')}`;

    const reply = await askGroq(message, context, history);
    return res.json({ reply });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Cron endpoint - called by n8n every minute to expire pending orders
router.post('/expire-orders', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const now = new Date().toISOString();

    const expiredOrders = await db.execute({
      sql: "SELECT * FROM orders WHERE status = 'pending' AND expires_at < ?",
      args: [now],
    });

    for (const order of expiredOrders.rows) {
      await db.execute({
        sql: 'UPDATE inventory SET quantity_kg = quantity_kg + ?, updated_at = CURRENT_TIMESTAMP WHERE sku = ?',
        args: [order.quantity_kg, order.sku],
      });

      await db.execute({
        sql: "UPDATE orders SET status = 'failed' WHERE invoice_id = ?",
        args: [order.invoice_id],
      });
    }

    res.json({ expired: expiredOrders.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;