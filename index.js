const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeFirebase } = require('./lib/firebase');
const messageRouter = require('./routes/messages');

require('dotenv').config();

const app = express();

// Configuración de CORS
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://mipctemuco.netlify.app']
    : ['http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Aplicar CORS
app.use(cors(corsOptions));

// Middleware para preflight requests
app.options('*', cors(corsOptions));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware para logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - Origin: ${req.get('origin')}`);
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      version: 'baileys',
      environment: process.env.NODE_ENV || 'development'
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
  try {
    const { userId } = req.params;
    const { getConnection } = require('./lib/baileys');
    
    const connection = await getConnection(userId);
    
    // Log del estado de la conexión
    console.log(`QR request for userId ${userId}:`, {
      hasQR: !!connection.qr,
      isConnected: connection.connected,
      connecting: connection.connecting
    });
    
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

// Verificar estado de WhatsApp
app.get('/api/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { getConnection } = require('./lib/baileys');
    
    const connection = await getConnection(userId);
    
    res.json({
      success: true,
      status: connection.connected ? 'connected' : 'disconnected',
      qrRequired: !connection.connected && !!connection.qr,
      qr: connection.qr,
      connecting: connection.connecting
    });
  } catch (error) {
    console.error('Status check error:', error);
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
    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Firebase:', error);
  }
})();

// Rutas de mensajes
app.use('/api/messages', messageRouter);

// Manejador de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp service running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal. Closing server...');
  server.close(() => {
    console.log('WhatsApp service terminated');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  server.close(() => {
    console.log('Server closed due to uncaught exception');
    process.exit(1);
  });
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  server.close(() => {
    console.log('Server closed due to unhandled rejection');
    process.exit(1);
  });
});