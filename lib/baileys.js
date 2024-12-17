const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    makeCacheableSignalKeyStore 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

// Almacenamiento de conexiones activas
const connections = new Map();
const connectionPromises = new Map();

// Configuración de logger
const logger = pino({ level: 'silent' });

// Función para verificar el estado de conexión
// En whatsapp-service/lib/baileys.js
async function checkConnection(userId) {
    if (!userId) {
        return { 
            success: false, 
            error: 'userId es requerido',
            status: 'disconnected'
        };
    }

    try {
        // Si no hay conexión, intentar inicializar
        if (!connections.has(userId)) {
            console.log(`Iniciando nueva conexión para ${userId}`);
            await initializeConnection(userId);
        }

        const connection = connections.get(userId);
        
        console.log(`Estado actual de conexión para ${userId}:`, {
            connected: connection.connected,
            connecting: connection.connecting,
            hasQR: !!connection.qr
        });

        return {
            success: true,
            status: connection.connected ? 'connected' : 'disconnected',
            connected: connection.connected,
            qrRequired: !connection.connected && !!connection.qr,
            qr: connection.qr,
            connecting: connection.connecting
        };
    } catch (error) {
        console.error(`Error checking connection for ${userId}:`, error);
        return {
            success: false,
            error: error.message,
            status: 'error',
            connected: false
        };
    }
}

async function initializeConnection(userId, forceNew = false) {
    try {
        console.log(`[${userId}] Iniciando conexión de WhatsApp...`);
        
        // Si ya hay una promesa de conexión en curso, esperar a que termine
        if (connectionPromises.has(userId)) {
            console.log(`[${userId}] Esperando conexión en curso...`);
            return await connectionPromises.get(userId);
        }

        // Si hay una conexión existente y está conectada, usarla
        if (!forceNew && connections.has(userId)) {
            const existingConn = connections.get(userId);
            if (existingConn.connected) {
                console.log(`[${userId}] Usando conexión existente`);
                return existingConn.socket;
            }
        }

        // Crear promesa de conexión
        const connectionPromise = (async () => {
            const AUTH_DIR = path.join(process.cwd(), 'auth', userId);
            if (!fs.existsSync(AUTH_DIR)) {
                fs.mkdirSync(AUTH_DIR, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

            const socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger)
                },
                printQRInTerminal: true,
                logger,
                browser: ['Chrome (Linux)', '', ''],
                connectTimeoutMs: 60000,
                generateHighQualityLinkPreview: true,
                defaultQueryTimeoutMs: 60000
            });

            const connectionInfo = {
                socket,
                connected: false,
                qr: null,
                attempts: 0,
                connecting: true,
                lastError: null
            };
            
            connections.set(userId, connectionInfo);

            // Manejar eventos de conexión
            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                console.log(`[${userId}] Estado de conexión:`, update);

                if (qr) {
                    try {
                        const qrUrl = await QRCode.toDataURL(qr);
                        connectionInfo.qr = qrUrl;
                        connectionInfo.attempts += 1;
                        connectionInfo.connecting = true;
                        connections.set(userId, { ...connectionInfo });
                        console.log(`[${userId}] Nuevo QR generado (intento ${connectionInfo.attempts})`);
                    } catch (error) {
                        console.error(`[${userId}] Error al generar QR:`, error);
                        connectionInfo.lastError = error.message;
                    }
                }

                if (connection === 'open') {
                    console.log(`[${userId}] ¡Conexión establecida con éxito!`);
                    connectionInfo.connected = true;
                    connectionInfo.connecting = false;
                    connectionInfo.qr = null;
                    connectionInfo.attempts = 0;
                    connectionInfo.lastError = null;
                    connections.set(userId, { ...connectionInfo });
                }

                if (connection === 'close') {
                    connectionInfo.connected = false;
                    connectionInfo.connecting = false;
                    
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`[${userId}] Conexión cerrada. Código:`, statusCode);

                    if (statusCode === DisconnectReason.loggedOut) {
                        console.log(`[${userId}] Sesión cerrada, eliminando credenciales...`);
                        if (fs.existsSync(AUTH_DIR)) {
                            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        }
                        connections.delete(userId);
                        connectionPromises.delete(userId);
                    } else {
                        connectionInfo.lastError = lastDisconnect?.error?.message || 'Conexión cerrada';
                        console.log(`[${userId}] Reconectando en 5 segundos...`);
                        setTimeout(() => initializeConnection(userId, true), 5000);
                    }
                }
            });

            socket.ev.on('creds.update', async () => {
                console.log(`[${userId}] Credenciales actualizadas`);
                await saveCreds();
            });

            return socket;
        })();

        // Guardar la promesa de conexión
        connectionPromises.set(userId, connectionPromise);

        try {
            const socket = await connectionPromise;
            return socket;
        } finally {
            // Limpiar la promesa cuando termine
            connectionPromises.delete(userId);
        }

    } catch (error) {
        console.error(`[${userId}] Error en initializeConnection:`, error);
        connectionPromises.delete(userId);
        throw error;
    }
}

async function getConnection(userId) {
    try {
        if (!userId) {
            throw new Error('userId es requerido');
        }

        if (!connections.has(userId)) {
            await initializeConnection(userId);
        }

        const connection = connections.get(userId);
        if (!connection) {
            throw new Error('No se pudo obtener la conexión');
        }

        return connection;
    } catch (error) {
        console.error('Error en getConnection:', error);
        throw error;
    }
}

async function sendMessage(userId, to, message, images = []) {
    try {
        if (!userId || !to || !message) {
            throw new Error('userId, destinatario y mensaje son requeridos');
        }

        // Verificar estado de conexión
        const connectionStatus = await checkConnection(userId);
        if (!connectionStatus.success) {
            throw new Error(`Error de conexión: ${connectionStatus.error}`);
        }

        if (!connectionStatus.connected) {
            throw new Error('WhatsApp no está conectado. Por favor, escanea el código QR primero.');
        }

        const connection = await getConnection(userId);
        const socket = connection.socket;

        // Formatear número
        const jid = to.includes('@s.whatsapp.net') ? 
            to : `${to.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

        // Log detallado
        console.log(`[${userId}] Enviando mensaje a ${jid}:`, {
            messageLength: message.length,
            hasImages: images.length > 0
        });

        try {
            // Enviar mensaje de texto
            const messageResponse = await socket.sendMessage(jid, { 
                text: message 
            });

            // Enviar imágenes si hay
            if (images && images.length > 0) {
                for (const image of images) {
                    if (image.url) {
                        await socket.sendMessage(jid, {
                            image: { url: image.url },
                            caption: image.type === 'before' ? 'Estado inicial' : 'Estado final'
                        });
                    }
                }
            }

            console.log(`[${userId}] Mensaje enviado exitosamente:`, messageResponse.key.id);
            return { success: true, messageId: messageResponse.key.id };

        } catch (sendError) {
            console.error(`[${userId}] Error al enviar mensaje:`, sendError);
            throw new Error(`Error al enviar mensaje: ${sendError.message}`);
        }

    } catch (error) {
        console.error('Error detallado en sendMessage:', {
            error: error.message,
            stack: error.stack,
            userId,
            to
        });
        throw error;
    }
}

// Limpieza periódica de conexiones inactivas
setInterval(() => {
    for (const [userId, connection] of connections.entries()) {
        if (!connection.connected && !connection.connecting) {
            console.log(`Limpiando conexión inactiva de ${userId}`);
            connections.delete(userId);
        }
    }
}, 30 * 60 * 1000); // Cada 30 minutos

module.exports = {
    sendMessage,
    getConnection,
    initializeConnection,
    checkConnection
};