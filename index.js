const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeFirebase } = require('./lib/firebase');
const messageRouter = require('./routes/messages');

require('dotenv').config();

const app = express();

// Configuración de CORS
app.use(cors({
  origin: ['https://mipctemuco.netlify.app', 'http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      version: 'baileys'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ status: 'error', error: error.message });
  }
});

// Página de login de WhatsApp
app.get('/login/:userId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

// QR code endpoint
app.get('/api/qr/:userId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { userId } = req.params;
    const { getConnection } = require('./lib/baileys');
    
    const connection = await getConnection(userId);
    
    if (connection.qr) {
      res.json({
        success: true,
        qr: connection.qr,
        status: 'pending'
      });
    } else if (connection.connected) {
      res.json({
        success: true,
        status: 'connected'
      });
    } else {
      res.json({
        success: true,
        status: 'initializing'
      });
    }
  } catch (error) {
    console.error('QR error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Initialize Firebase
(async () => {
  try {
    await initializeFirebase();
  } catch (error) {
    console.error('Failed to initialize Firebase:', error);
  }
})();

app.use('/api/messages', messageRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message
  });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    console.log('WhatsApp service terminated');
  });
});