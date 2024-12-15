const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeFirebase } = require('./lib/firebase');
const messageRouter = require('./routes/messages');

require('dotenv').config();

const app = express();

// Configuración de CORS mejorada
const corsOptions = {
  origin: function(origin, callback) {
    const allowedOrigins = process.env.NODE_ENV === 'production' 
      ? [
          'https://mipctemuco.netlify.app',
          'https://backendst.up.railway.app',
          'https://whatsapp-service.onrender.com'
        ]
      : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'];

    // Permitir requests sin origin (como mobile apps o curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('Origin blocked by CORS:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept', 
    'Origin',
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Headers'
  ],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false,
  maxAge: 86400 // 24 horas de cache para preflight
};

// Aplicar CORS
app.use(cors(corsOptions));

// Middleware para preflight requests
app.options('*', cors(corsOptions));

// Middlewares básicos
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware para logging mejorado
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(
      `${new Date().toISOString()} - ${req.method} ${req.url} - ${res.statusCode} - ${duration}ms - Origin: ${req.get('origin')}`
    );
  });
  next();
});

// Headers de seguridad
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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

// QR code endpoint con mejor manejo de errores
app.get('/api/qr/:userId', async (req, res) => {
  const startTime = Date.now();
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const { getConnection } = require('./lib/baileys');
    const connection = await getConnection(userId);
    
    console.log(`QR request for userId ${userId}:`, {
      hasQR: !!connection.qr,
      isConnected: connection.connected,
      connecting: connection.connecting,
      responseTime: Date.now() - startTime
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
      error: error.message || 'Internal server error',
      errorTime: Date.now() - startTime
    });
  }
});

// Verificar estado de WhatsApp con timeout
app.get('/api/status/:userId', async (req, res) => {
  const startTime = Date.now();
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const { getConnection } = require('./lib/baileys');
    
    // Agregar timeout de 30 segundos
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout')), 30000)
    );
    
    const connectionPromise = getConnection(userId);
    const connection = await Promise.race([connectionPromise, timeoutPromise]);
    
    res.json({
      success: true,
      status: connection.connected ? 'connected' : 'disconnected',
      qrRequired: !connection.connected && !!connection.qr,
      qr: connection.qr,
      connecting: connection.connecting,
      responseTime: Date.now() - startTime
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(error.message === 'Connection timeout' ? 504 : 500).json({
      success: false,
      error: error.message || 'Internal server error',
      errorTime: Date.now() - startTime
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
    message: 'Route not found',
    path: req.originalUrl
  });
});

// Error handler mejorado
app.use((err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    path: req.path,
    timestamp: new Date().toISOString(),
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`WhatsApp service running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});

// Graceful shutdown mejorado
process.on('SIGTERM', () => {
  console.log('Received SIGTERM signal. Closing server...');
  server.close(() => {
    console.log('WhatsApp service terminated');
    process.exit(0);
  });
  // Forzar cierre después de 30 segundos
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  server.close(() => {
    console.log('Server closed due to uncaught exception');
    process.exit(1);
  });
  // Forzar cierre después de 30 segundos
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  server.close(() => {
    console.log('Server closed due to unhandled rejection');
    process.exit(1);
  });
  // Forzar cierre después de 30 segundos
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
});