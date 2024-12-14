const express = require('express');
const cors = require('cors');
const { initializeFirebase, checkConnection } = require('./lib/firebase');
const messageRouter = require('./routes/messages');
const https = require('https');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

// Configuración de seguridad básica
app.use(helmet());

// Configurar CORS
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400 // 24 horas
};
app.use(cors(corsOptions));

// Límite de velocidad para las solicitudes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // límite de 100 solicitudes por ventana por IP
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

// Middleware para parsear JSON con límite de tamaño
app.use(express.json({ limit: '10mb' }));

// Middleware de logging mejorado
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Inicializar Firebase
initializeFirebase();

// Health check mejorado
app.get('/health', async (req, res) => {
  try {
    const isFirebaseConnected = await checkConnection();
    
    // Verificar el estado general del servicio
    const status = {
      timestamp: new Date().toISOString(),
      service: 'ok',
      firebase: isFirebaseConnected ? 'connected' : 'disconnected',
      environment: process.env.NODE_ENV,
      uptime: process.uptime()
    };

    // Si Firebase no está conectado, devolver 500
    if (!isFirebaseConnected) {
      return res.status(500).json({
        ...status,
        error: 'Firebase connection failed'
      });
    }

    res.json(status);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      timestamp: new Date().toISOString(),
      service: 'error',
      error: error.message
    });
  }
});

// Rutas
app.use('/api/messages', messageRouter);

// Manejador de errores mejorado
app.use((err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method
  });

  // Determinar el código de estado apropiado
  const statusCode = err.status || err.statusCode || 500;
  
  // Preparar el mensaje de error
  const errorResponse = {
    success: false,
    message: err.message || 'Internal server error',
    code: err.code,
    timestamp: new Date().toISOString()
  };

  // Solo incluir stack trace en desarrollo
  if (process.env.NODE_ENV === 'development') {
    errorResponse.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`WhatsApp service running on port ${PORT}`);
});

// Función para mantener el servicio activo
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  
  const interval = setInterval(() => {
    https.get(`${url}/health`, (resp) => {
      if (resp.statusCode === 200) {
        console.log('Keepalive check successful');
      } else {
        console.warn(`Keepalive check returned status ${resp.statusCode}`);
      }
    }).on('error', (err) => {
      console.error('Keepalive check failed:', err);
    });
  }, 5 * 60 * 1000); // Cada 5 minutos

  // Limpiar intervalo al apagar el servidor
  process.on('SIGTERM', () => {
    clearInterval(interval);
    server.close(() => {
      console.log('Server shutting down gracefully');
      process.exit(0);
    });
  });
}

// Iniciar keepAlive en producción
if (process.env.NODE_ENV === 'production') {
  keepAlive();
}

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Intentar cerrar el servidor de manera limpia
  server.close(() => {
    console.log('Server closed due to uncaught exception');
    process.exit(1);
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // No cerramos el servidor, solo loggeamos el error
});

module.exports = server;