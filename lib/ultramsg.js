const axios = require('axios');

// Configuración optimizada para UltraMsg
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 10000;
const TIMEOUT = 30000;

async function getUltraMsgCredentials(userId) {
  try {
    const db = require('firebase-admin').firestore();
    const configDoc = await db.collection('users').doc(userId)
      .collection('settings').doc('whatsapp')
      .get();
    
    if (!configDoc.exists) {
      throw new Error('No se encontraron credenciales de WhatsApp');
    }

    const config = configDoc.data();
    return {
      instance_id: config.ultramsg?.instance_id,
      token: config.ultramsg?.token
    };
  } catch (error) {
    console.error('Error obteniendo credenciales:', error);
    throw error;
  }
}

async function sendUltraMsgMessage(credentials, phone, message, requestId) {
  const { instance_id, token } = credentials;
  
  if (!instance_id || !token) {
    throw new Error('Credenciales de UltraMsg incompletas');
  }

  // Construir la URL de la API de UltraMsg
  const apiUrl = `https://api.ultramsg.com/${instance_id}/messages/chat`;

  console.log(`[${requestId}] Enviando mensaje a UltraMsg:`, {
    url: apiUrl,
    phone,
    messageLength: message.length
  });

  // Hacer la petición a UltraMsg
  const response = await axios.post(apiUrl, {
    token,
    to: phone,
    body: message
  }, {
    headers: {
      'Content-Type': 'application/json'
    },
    timeout: TIMEOUT
  });

  console.log(`[${requestId}] Respuesta de UltraMsg:`, response.data);

  return response.data;
}

const sendMessage = async (to, message, userId, images = []) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    console.log(`[${requestId}] Iniciando envío de mensaje:`, {
      to,
      messageLength: message.length,
      hasImages: images.length > 0
    });

    // Obtener credenciales
    const credentials = await getUltraMsgCredentials(userId);

    // Formatear el número de teléfono (eliminar el + si existe)
    const formattedPhone = to.startsWith('+') ? to.substring(1) : to;

    // Sistema de reintentos
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await sendUltraMsgMessage(
          credentials, 
          formattedPhone, 
          message,
          requestId
        );

        console.log(`[${requestId}] Mensaje enviado exitosamente:`, result);

        // Si hay imágenes, enviarlas una por una
        if (images && images.length > 0) {
          for (const image of images) {
            if (!image.url) continue;
            
            await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar entre imágenes
            
            await sendUltraMsgMessage(
              credentials,
              formattedPhone,
              image.url,
              `${requestId}-img`
            );

            if (image.caption) {
              await new Promise(resolve => setTimeout(resolve, 500));
              await sendUltraMsgMessage(
                credentials,
                formattedPhone,
                image.caption,
                `${requestId}-caption`
              );
            }
          }
        }

        return result;

      } catch (error) {
        lastError = error;
        console.error(`[${requestId}] Error en intento ${attempt}/${MAX_RETRIES}:`, {
          error: error.message,
          response: error.response?.data
        });

        if (attempt < MAX_RETRIES) {
          const delay = Math.min(INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1), MAX_RETRY_DELAY);
          console.log(`[${requestId}] Reintentando en ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Error desconocido enviando mensaje');

  } catch (error) {
    console.error(`[${requestId}] Error fatal:`, error);
    throw error;
  }
};

module.exports = sendMessage;