const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeFirebase } = require('./lib/firebase');
const messageRouter = require('./routes/messages');
const settingsRouter = require('./api/settings');

require('dotenv').config();

const app = express();

// Configuración de CORS mejorada y más permisiva para producción
const corsOptions = {
  origin: true, // Permite todos los orígenes
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept', 
    'Origin',
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Methods'
  ],
  credentials: true,
  optionsSuccessStatus: 200,
  preflightContinue: false,
  maxAge: 86400
};

// Aplicar CORS como primer middleware
app.use(cors(corsOptions));

// Middleware para preflight requests
app.options('*', cors(corsOptions));
app.use('/api', settingsRouter);

// Headers de CORS adicionales para cada respuesta
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin');
  next();
});

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

// Headers de seguridad (modificados para permitir iframe en desarrollo)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  
  next();
});

// Health check endpoint con timeout
app.get('/health', async (req, res) => {
  const timeout = setTimeout(() => {
    res.status(503).json({ 
      status: 'error', 
      error: 'Health check timeout' 
    });
  }, 5000);

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
  } finally {
    clearTimeout(timeout);
  }
});

// Página de login de WhatsApp
app.get('/login/:userId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

// QR code endpoint con mejor manejo de errores y timeout
app.get('/api/qr/:userId', async (req, res) => {
  const startTime = Date.now();
  const timeout = setTimeout(() => {
    res.status(504).json({
      success: false,
      error: 'Request timeout',
      errorTime: Date.now() - startTime
    });
  }, 30000);

  try {
    const { userId } = req.params;
    if (!userId) {
      clearTimeout(timeout);
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

    clearTimeout(timeout);
    
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
    clearTimeout(timeout);
    console.error('QR error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      errorTime: Date.now() - startTime
    });
  }
});


// Endpoint para reconexión automática
app.post('/api/reconnect/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const { getConnection, initializeConnection } = require('./lib/baileys');
    
    // Intentar obtener conexión existente primero
    try {
      const connection = await getConnection(userId);
      
      if (connection.connected) {
        return res.json({
          success: true,
          status: 'connected'
        });
      }
    } catch (connectionError) {
      console.error('Error getting existing connection:', connectionError);
    }

    // Si no hay conexión o falló, intentar inicializar una nueva
    try {
      await initializeConnection(userId, true); // force new connection
      const newConnection = await getConnection(userId);
      
      res.json({
        success: true,
        status: newConnection.connected ? 'connected' : 'initializing',
        qrRequired: !newConnection.connected && !!newConnection.qr,
        qr: newConnection.qr
      });
    } catch (initError) {
      throw new Error(`Error initializing connection: ${initError.message}`);
    }

  } catch (error) {
    console.error('Reconnection error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});


app.post('/api/unlink/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const { getConnection } = require('./lib/baileys');
    const fs = require('fs');
    const path = require('path');

    // Obtener la conexión actual
    const connection = await getConnection(userId);
    
    // Cerrar la conexión si existe
    if (connection && connection.socket) {
      await connection.socket.logout();
      await connection.socket.end();
    }

    // Eliminar archivos de autenticación
    const AUTH_DIR = path.join(process.cwd(), 'auth', userId);
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }

    // Limpiar la conexión del mapa de conexiones
    const connections = new Map(); // Asegúrate de tener acceso al mapa de conexiones
    connections.delete(userId);

    res.json({
      success: true,
      message: 'WhatsApp desvinculado exitosamente'
    });

  } catch (error) {
    console.error('Error unlinking WhatsApp:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al desvincular WhatsApp'
    });
  }
});

// Verificar estado de WhatsApp con timeout optimizado
app.get('/api/status/:userId', async (req, res) => {
  const startTime = Date.now();
  const timeout = setTimeout(() => {
    res.status(504).json({
      success: false,
      error: 'Connection timeout',
      errorTime: Date.now() - startTime
    });
  }, 30000);

  try {
    const { userId } = req.params;
    if (!userId) {
      clearTimeout(timeout);
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const { getConnection } = require('./lib/baileys');
    const connection = await getConnection(userId);
    
    console.log(`Estado de WhatsApp para ${userId}:`, {
      hasQR: !!connection.qr,
      isConnected: connection.connected,
      connecting: connection.connecting
    });

    clearTimeout(timeout);

    // Responder con estado detallado
    res.json({
      success: true,
      status: connection.connected ? 'connected' : 'disconnected',
      connected: connection.connected,
      qrRequired: !connection.connected && !!connection.qr,
      qr: connection.qr,
      connecting: connection.connecting,
      responseTime: Date.now() - startTime
    });

  } catch (error) {
    clearTimeout(timeout);
    console.error('Error en status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      errorTime: Date.now() - startTime,
      status: 'error'
    });
  }
});

// Initialize Firebase with retry
(async () => {
  let retries = 3;
  while (retries > 0) {
    try {
      await initializeFirebase();
      console.log('Firebase initialized successfully');
      break;
    } catch (error) {
      retries--;
      console.error(`Failed to initialize Firebase (${retries} retries left):`, error);
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
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
let server;

try {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`WhatsApp service running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  });
} catch (error) {
  console.error('Failed to start server:', error);
  process.exit(1);
}

// Función de limpieza
const cleanup = () => {
  if (server) {
    server.close(() => {
      console.log('Server closed gracefully');
      process.exit(0);
    });

    // Forzar cierre después de 30 segundos
    setTimeout(() => {
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 30000);
  }
};

// Gestión de señales del sistema
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  cleanup();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  cleanup();
});