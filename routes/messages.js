const express = require('express');
const router = express.Router();
const { getFirebase } = require('../lib/firebase');
const sendMessage = require('../lib/ultramsg');
const { getFirestore } = require('firebase-admin/firestore');


// Cache para plantillas de mensajes
const messageTemplatesCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos

// Función para procesar plantillas de mensaje
function processTemplate(template, data) {
  return template
    .replace(/{clientName}/g, data.clientName || '')
    .replace(/{deviceBrand}/g, data.deviceBrand || '')
    .replace(/{deviceModel}/g, data.deviceModel || '')
    .replace(/{trackingUrl}/g, data.trackingUrl || '')
    .replace(/{estimatedDate}/g, data.estimatedDate || '')
    .replace(/{totalAmount}/g, data.totalAmount?.toString() || '');
}

// Obtener plantillas de mensaje con caché
async function getMessageTemplates(userId) {
  const cacheKey = `templates-${userId}`;
  const cached = messageTemplatesCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.templates;
  }

  const db = getFirebase().firestore();
  const configRef = db.collection('users').doc(userId)
    .collection('settings').doc('whatsapp');
  const configDoc = await configRef.get();

  if (!configDoc.exists) {
    throw new Error('WhatsApp configuration not found');
  }

  const templates = configDoc.data().messages || {};
  
  messageTemplatesCache.set(cacheKey, {
    templates,
    timestamp: Date.now()
  });

  return templates;
}

// Ruta para enviar mensaje genérico
router.post('/send', async (req, res) => {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { userId, to, message, images } = req.body;

    // Validación mejorada
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'UserId inválido o no proporcionado'
      });
    }

    if (!to || typeof to !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Número de teléfono inválido o no proporcionado'
      });
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mensaje inválido o no proporcionado'
      });
    }

    // Log de la solicitud
    console.log(`[${requestId}] Nueva solicitud de mensaje:`, {
      userId,
      to,
      messageLength: message.length,
      hasImages: Array.isArray(images) && images.length > 0
    });

    // Enviar respuesta inmediata
    res.json({
      success: true,
      requestId,
      message: 'Mensaje en proceso de envío'
    });

    // Procesar mensaje de forma asíncrona
    try {
      await sendMessage(to, message, userId, images);
      console.log(`[${requestId}] Mensaje enviado exitosamente`);
    } catch (error) {
      console.error(`[${requestId}] Error en envío asíncrono:`, error);
      // Aquí podrías implementar una cola de reintentos o notificación
    }

  } catch (error) {
    console.error(`[${requestId}] Error:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Ruta para notificar orden creada
router.post('/order-created', async (req, res) => {
  try {
    const { userId, order, clientPhone, clientName } = req.body;

    if (!userId || !order || !clientPhone || !clientName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const templates = await getMessageTemplates(userId);
    const trackingUrl = `${process.env.FRONTEND_URL}/order/${userId}/${order.id}`;

    const messageData = {
      clientName,
      deviceBrand: order.deviceBrand,
      deviceModel: order.deviceModel,
      trackingUrl,
      estimatedDate: new Date(order.estimatedDeliveryDate).toLocaleDateString(),
      totalAmount: order.totalAmount
    };

    const message = processTemplate(templates.orderCreated, messageData);
    const result = await sendMessage(clientPhone, message, userId);

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Error sending order creation notification:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Ruta para notificar orden completada
router.post('/order-completed', async (req, res) => {
  try {
    const { userId, order, clientPhone, clientName } = req.body;

    if (!userId || !order || !clientPhone || !clientName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const templates = await getMessageTemplates(userId);
    const trackingUrl = `${process.env.FRONTEND_URL}/order/${userId}/${order.id}`;

    const messageData = {
      clientName,
      deviceBrand: order.deviceBrand,
      deviceModel: order.deviceModel,
      trackingUrl
    };

    const message = processTemplate(templates.orderCompleted, messageData);
    const result = await sendMessage(clientPhone, message, userId, order.serviceImages);

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Error sending order completion notification:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Ruta para notificar orden lista para retirar
router.post('/order-ready', async (req, res) => {
  try {
    const { userId, order, clientPhone, clientName } = req.body;

    if (!userId || !order || !clientPhone || !clientName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const templates = await getMessageTemplates(userId);
    const trackingUrl = `${process.env.FRONTEND_URL}/order/${userId}/${order.id}`;

    const messageData = {
      clientName,
      deviceBrand: order.deviceBrand,
      deviceModel: order.deviceModel,
      trackingUrl
    };

    const message = processTemplate(templates.orderReady || templates.orderCompleted, messageData);
    const result = await sendMessage(clientPhone, message, userId);

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Error sending order ready notification:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint para probar la conexión de WhatsApp
router.post('/test-whatsapp', async (req, res) => {
  const requestId = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId es requerido'
      });
    }

    console.log(`[${requestId}] Testing WhatsApp connection for userId:`, userId);

    // Obtener configuración del usuario
    const db = getFirestore();
    const configDoc = await db.collection('users').doc(userId)
      .collection('settings').doc('whatsapp')
      .get();

    if (!configDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Configuración de WhatsApp no encontrada'
      });
    }

    const config = configDoc.data();
    const testPhone = config.ultramsg?.testPhone || config.testPhone;

    if (!testPhone) {
      return res.status(400).json({
        success: false,
        error: 'No hay número de prueba configurado'
      });
    }

    // Enviar mensaje de prueba
    const testMessage = '🔄 Prueba de conexión exitosa\n\nEste es un mensaje automático para verificar la configuración de WhatsApp.';
    
    await sendMessage(testPhone, testMessage, userId);

    console.log(`[${requestId}] Test connection successful`);

    res.json({
      success: true,
      message: 'Conexión probada exitosamente'
    });

  } catch (error) {
    console.error(`[${requestId}] Test connection failed:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Error al probar la conexión'
    });
  }
});

module.exports = router;