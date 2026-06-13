const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { authenticate } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'SKU Assistant Backend is running' });
});

app.use('/auth', authRoutes);
app.use('/chat', authenticate, chatRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});