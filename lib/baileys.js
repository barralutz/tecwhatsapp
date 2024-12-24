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
        
        const AUTH_DIR = path.join(process.cwd(), 'auth', userId);
        const hasExistingSession = fs.existsSync(AUTH_DIR) && 
            fs.readdirSync(AUTH_DIR).length > 0;

        // Limpiar conexión existente si es forzado
        if (forceNew && connections.has(userId)) {
            const existingConn = connections.get(userId);
            if (existingConn?.socket) {
                try {
                    await existingConn.socket.logout();
                    await existingConn.socket.end();
                } catch (error) {
                    console.log(`[${userId}] Error al cerrar conexión existente:`, error);
                }
            }
            connections.delete(userId);
        }

        if (connectionPromises.has(userId)) {
            return await connectionPromises.get(userId);
        }

        const connectionPromise = (async () => {
            if (!fs.existsSync(AUTH_DIR)) {
                fs.mkdirSync(AUTH_DIR, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
            
            let connectionTimeout;
            let qrTimeout;

            const socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger)
                },
                printQRInTerminal: true,
                logger,
                browser: ['Chrome (Linux)', '', ''],
                connectTimeoutMs: CONNECTION_TIMEOUT,
                qrTimeout: QR_TIMEOUT,
                defaultQueryTimeoutMs: 30000,
                retryRequestDelayMs: 2000
            });

            const connectionInfo = {
                socket,
                connected: false,
                qr: null,
                attempts: 0,
                connecting: true,
                lastError: null,
                hasExistingSession,
                qrTimeout: null,
                connectionTimeout: null
            };

            connections.set(userId, connectionInfo);

            // Establecer timeout de conexión
            connectionTimeout = setTimeout(() => {
                console.log(`[${userId}] Timeout de conexión alcanzado`);
                handleConnectionFailure();
            }, CONNECTION_TIMEOUT);

            const handleConnectionFailure = async () => {
                clearTimeout(connectionTimeout);
                clearTimeout(qrTimeout);
                
                connectionInfo.connected = false;
                connectionInfo.connecting = false;
                
                if (fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                }
                
                try {
                    await socket.logout();
                    await socket.end();
                } catch (error) {
                    console.log(`[${userId}] Error al cerrar socket:`, error);
                }
                
                connections.delete(userId);
                connectionPromises.delete(userId);
            };

            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                console.log(`[${userId}] Estado de conexión:`, {
                    connection,
                    hasQR: !!qr,
                    disconnectCode: lastDisconnect?.error?.output?.statusCode
                });

                if (qr) {
                    // Limpiar timeout anterior si existe
                    if (qrTimeout) clearTimeout(qrTimeout);
                    
                    // Verificar número de intentos
                    if (connectionInfo.attempts >= MAX_QR_ATTEMPTS) {
                        console.log(`[${userId}] Máximo de intentos QR alcanzado`);
                        await handleConnectionFailure();
                        return;
                    }

                    try {
                        const qrUrl = await QRCode.toDataURL(qr);
                        connectionInfo.qr = qrUrl;
                        connectionInfo.attempts += 1;
                        connectionInfo.connecting = true;
                        connections.set(userId, { ...connectionInfo });

                        // Establecer nuevo timeout para este QR
                        qrTimeout = setTimeout(() => {
                            if (!connectionInfo.connected) {
                                console.log(`[${userId}] Timeout de QR alcanzado`);
                                handleConnectionFailure();
                            }
                        }, QR_TIMEOUT);

                        console.log(`[${userId}] Nuevo QR generado (intento ${connectionInfo.attempts}/${MAX_QR_ATTEMPTS})`);
                    } catch (error) {
                        console.error(`[${userId}] Error al generar QR:`, error);
                        connectionInfo.lastError = error.message;
                    }
                }

                if (connection === 'open') {
                    clearTimeout(connectionTimeout);
                    clearTimeout(qrTimeout);
                    
                    console.log(`[${userId}] ¡Conexión establecida con éxito!`);
                    connectionInfo.connected = true;
                    connectionInfo.connecting = false;
                    connectionInfo.qr = null;
                    connectionInfo.attempts = 0;
                    connectionInfo.lastError = null;
                    connections.set(userId, { ...connectionInfo });
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`[${userId}] Conexión cerrada. Código:`, statusCode);
                    
                    await handleConnectionFailure();
                }
            });

            socket.ev.on('creds.update', async () => {
                console.log(`[${userId}] Credenciales actualizadas`);
                await saveCreds();
            });

            return socket;
        })();

        connectionPromises.set(userId, connectionPromise);

        try {
            const socket = await connectionPromise;
            return socket;
        } finally {
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