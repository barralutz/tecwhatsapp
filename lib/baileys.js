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
        
        // Verificar si ya existe una sesión activa
        const AUTH_DIR = path.join(process.cwd(), 'auth', userId);
        const hasExistingSession = fs.existsSync(AUTH_DIR) && 
            fs.readdirSync(AUTH_DIR).length > 0;

        console.log(`[${userId}] Estado de sesión:`, {
            hasExistingSession,
            forceNew
        });

        // Si ya hay una promesa de conexión en curso, esperar a que termine
        if (connectionPromises.has(userId)) {
            console.log(`[${userId}] Esperando conexión en curso...`);
            return await connectionPromises.get(userId);
        }

        // Si hay una conexión existente y está conectada, usarla
        if (!forceNew && connections.has(userId)) {
            const existingConn = connections.get(userId);
            if (existingConn.connected) {
                console.log(`[${userId}] Usando conexión existente activa`);
                return existingConn.socket;
            }
        }

        // Crear promesa de conexión
        const connectionPromise = (async () => {
            if (!fs.existsSync(AUTH_DIR)) {
                fs.mkdirSync(AUTH_DIR, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

            // Verificar si hay credenciales válidas
            const hasValidCreds = state.creds?.me?.id !== undefined;
            console.log(`[${userId}] Estado de credenciales:`, {
                hasValidCreds,
                credsId: state.creds?.me?.id
            });

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
                defaultQueryTimeoutMs: 60000,
                retryRequestDelayMs: 2000
            });

            const connectionInfo = {
                socket,
                connected: false,
                qr: null,
                attempts: 0,
                connecting: true,
                lastError: null,
                hasExistingSession
            };
            
            connections.set(userId, connectionInfo);

            // Manejar eventos de conexión
            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                console.log(`[${userId}] Estado de conexión:`, {
                    connection,
                    hasQR: !!qr,
                    disconnectCode: lastDisconnect?.error?.output?.statusCode
                });

                const currentInfo = connections.get(userId) || connectionInfo;

                if (qr) {
                    try {
                        // Verificar si la sesión existente es inválida
                        if (currentInfo.hasExistingSession && currentInfo.attempts === 0) {
                            console.log(`[${userId}] Sesión existente inválida, limpiando...`);
                            if (fs.existsSync(AUTH_DIR)) {
                                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                            }
                            currentInfo.hasExistingSession = false;
                        }

                        const qrUrl = await QRCode.toDataURL(qr);
                        currentInfo.qr = qrUrl;
                        currentInfo.attempts += 1;
                        currentInfo.connecting = true;
                        connections.set(userId, { ...currentInfo });
                        console.log(`[${userId}] Nuevo QR generado (intento ${currentInfo.attempts})`);
                    } catch (error) {
                        console.error(`[${userId}] Error al generar QR:`, error);
                        currentInfo.lastError = error.message;
                    }
                }

                if (connection === 'open') {
                    console.log(`[${userId}] ¡Conexión establecida con éxito!`);
                    currentInfo.connected = true;
                    currentInfo.connecting = false;
                    currentInfo.qr = null;
                    currentInfo.attempts = 0;
                    currentInfo.lastError = null;
                    currentInfo.hasExistingSession = true;
                    connections.set(userId, { ...currentInfo });

                    // Intentar limpiar QR anterior si existe
                    if (fs.existsSync(path.join(AUTH_DIR, 'qr.png'))) {
                        try {
                            fs.unlinkSync(path.join(AUTH_DIR, 'qr.png'));
                        } catch (error) {
                            console.error(`[${userId}] Error al limpiar QR:`, error);
                        }
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`[${userId}] Conexión cerrada. Código:`, statusCode);

                    if (statusCode === DisconnectReason.loggedOut || 
                        statusCode === DisconnectReason.connectionClosed) {
                        console.log(`[${userId}] Sesión cerrada o inválida, limpiando...`);
                        currentInfo.connected = false;
                        currentInfo.connecting = false;
                        currentInfo.hasExistingSession = false;
                        
                        if (fs.existsSync(AUTH_DIR)) {
                            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        }
                        connections.delete(userId);
                        connectionPromises.delete(userId);
                        
                        // Reiniciar conexión después de limpiar
                        setTimeout(() => initializeConnection(userId, true), 2000);
                    } else {
                        currentInfo.connected = false;
                        currentInfo.connecting = false;
                        currentInfo.lastError = lastDisconnect?.error?.message || 'Conexión cerrada';
                        connections.set(userId, { ...currentInfo });
                        
                        if (currentInfo.attempts < 3) {
                            console.log(`[${userId}] Reconectando en 5 segundos...`);
                            setTimeout(() => initializeConnection(userId, true), 5000);
                        } else {
                            console.log(`[${userId}] Máximo de intentos alcanzado, limpiando sesión...`);
                            if (fs.existsSync(AUTH_DIR)) {
                                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                            }
                            connections.delete(userId);
                            connectionPromises.delete(userId);
                        }
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