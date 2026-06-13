const bcrypt = require('bcryptjs');
const db = require('./src/db');
require('dotenv').config();

async function seed() {
  const accounts = [
    { email: 'cofibeanadmin@cofibean.com', password: 'Wake9078!', role: 'admin' },
    { email: 'cofibeanagent@cofibean.com', password: 'Wake9078!', role: 'agent' },
  ];

  for (const acc of accounts) {
    const hash = await bcrypt.hash(acc.password, 10);
    await db.execute({
      sql: 'INSERT INTO agents (email, password_hash, role) VALUES (?, ?, ?)',
      args: [acc.email, hash, acc.role],
    });
    console.log('Created:', acc.email, '-', acc.role);
  }
}

seed().catch(console.error);