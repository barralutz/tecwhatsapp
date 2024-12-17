const express = require('express');
const router = express.Router();
const { getFirebase } = require('../lib/firebase');
const { sendMessage, getConnection } = require('../lib/baileys');

// Configuración CORS para las rutas
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  next();
});

// Manejar preflight requests
router.options('*', (req, res) => {
  res.sendStatus(200);
});

// Función para esperar a que la conexión esté lista
async function waitForConnection(userId, maxAttempts = 3) {
    let attempts = 0;
    while (attempts < maxAttempts) {
        const connection = await getConnection(userId);
        if (connection.connected) {
            return true;
        }
        console.log(`[${userId}] Esperando conexión... Intento ${attempts + 1}/${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
    }
    return false;
}

router.post('/send', async (req, res) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    try {
        const { userId, to, message, images } = req.body;

        console.log(`[${requestId}] Processing message request:`, {
            userId,
            to,
            hasImages: Array.isArray(images) && images.length > 0
        });

        if (!userId || !to || !message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Validar que el usuario existe en Firebase
        const db = getFirebase().firestore();
        const userDoc = await db.collection('users').doc(userId).get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        // Esperar a que la conexión esté lista
        const isConnected = await waitForConnection(userId);
        if (!isConnected) {
            return res.status(500).json({
                success: false,
                error: 'No se pudo establecer conexión con WhatsApp'
            });
        }

        // Enviar mensaje usando Baileys
        const result = await sendMessage(userId, to, message, images);

        console.log(`[${requestId}] Message sent successfully`);

        res.json({
            success: true,
            result
        });

    } catch (error) {
        console.error(`[${requestId}] Error sending message:`, error);

        let statusCode = 500;
        if (error.message.includes('no está conectado')) {
            statusCode = 503; // Service Unavailable
        } else if (error.message.includes('User not found')) {
            statusCode = 404;
        }

        res.status(statusCode).json({
            success: false,
            error: error.message,
            requestId
        });
    }
});

// Endpoint para verificar el estado de conexión
router.get('/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const connection = await getConnection(userId);
        
        res.json({
            success: true,
            status: connection.connected ? 'connected' : 'disconnected',
            qrRequired: !connection.connected && !!connection.qr,
            qr: connection.qr,
            connecting: connection.connecting
        });
    } catch (error) {
        console.error('Error checking status:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;