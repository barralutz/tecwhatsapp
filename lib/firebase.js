const admin = require('firebase-admin');

// Cache para la instancia de Firebase
let firebaseApp = null;
let dbConnection = null;

// Función para inicializar Firebase de manera segura
function initializeFirebase() {
  if (firebaseApp) {
    return firebaseApp;
  }

  try {
    console.log('Initializing Firebase Admin...');

    // Validar variables de entorno requeridas
    const requiredEnvVars = [
      'FIREBASE_PROJECT_ID',
      'FIREBASE_PRIVATE_KEY_ID',
      'FIREBASE_PRIVATE_KEY',
      'FIREBASE_CLIENT_EMAIL',
      'FIREBASE_CLIENT_ID'
    ];

    for (const envVar of requiredEnvVars) {
      if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
      }
    }

    // Crear el objeto de credenciales
    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_CLIENT_EMAIL)}`
    };

    // Inicializar Firebase Admin con configuración optimizada
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`,
      // Configuraciones de rendimiento
      httpAgent: new (require('http').Agent)({ 
        keepAlive: true,
        maxSockets: 25 // Limitar el número de conexiones concurrentes
      })
    });

    // Inicializar Firestore con configuraciones optimizadas
    dbConnection = firebaseApp.firestore();
    dbConnection.settings({
      ignoreUndefinedProperties: true, // Ignorar propiedades undefined
      minimumBackoffSeconds: 10, // Tiempo mínimo de espera entre reintentos
      maximumBackoffSeconds: 60 // Tiempo máximo de espera entre reintentos
    });

    console.log('Firebase Admin initialized successfully');
    return firebaseApp;
  } catch (error) {
    console.error('Firebase initialization error:', error);
    console.error('Service Account Details:', {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      // No imprimir private_key por seguridad
    });
    throw error;
  }
}

// Función para obtener la conexión a Firestore
function getFirestore() {
  if (!dbConnection) {
    initializeFirebase();
  }
  return dbConnection;
}

// Función para verificar el estado de la conexión
async function checkConnection() {
  try {
    if (!dbConnection) {
      initializeFirebase();
    }
    // Realizar una operación simple para verificar la conexión
    await dbConnection.collection('users').limit(1).get();
    return true;
  } catch (error) {
    console.error('Firebase connection check failed:', error);
    return false;
  }
}

// Manejar errores de conexión
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection in Firebase connection:', error);
  // Intentar reinicializar Firebase si es un error de conexión
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
    console.log('Attempting to reinitialize Firebase connection...');
    firebaseApp = null;
    dbConnection = null;
    initializeFirebase();
  }
});

// Sistema de reintentos para operaciones de Firebase
async function withRetry(operation, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Operation failed (attempt ${attempt}/${maxRetries}):`, error);
      lastError = error;
      
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Verificar y reinicializar conexión si es necesario
        if (!await checkConnection()) {
          console.log('Reinitializing Firebase connection before retry...');
          firebaseApp = null;
          dbConnection = null;
          initializeFirebase();
        }
      }
    }
  }
  throw lastError;
}

module.exports = {
  initializeFirebase,
  getFirestore,
  checkConnection,
  withRetry
};