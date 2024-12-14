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
                connecting: true
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
                        connections.set(userId, { ...connectionInfo });
                        console.log(`[${userId}] Nuevo QR generado (intento ${connectionInfo.attempts})`);
                    } catch (error) {
                        console.error(`[${userId}] Error al generar QR:`, error);
                    }
                }

                if (connection === 'open') {
                    console.log(`[${userId}] ¡Conexión establecida con éxito!`);
                    connectionInfo.connected = true;
                    connectionInfo.connecting = false;
                    connectionInfo.qr = null;
                    connectionInfo.attempts = 0;
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
    if (!connections.has(userId)) {
      await initializeConnection(userId);
    }
    return connections.get(userId);
  } catch (error) {
    console.error('Error en getConnection:', error);
    throw error;
  }
}

async function sendMessage(userId, to, message, images = []) {
  try {
    const connection = await getConnection(userId);
    
    if (!connection.connected) {
      throw new Error('WhatsApp no está conectado. Por favor, escanea el código QR primero.');
    }

    const socket = connection.socket;
    let jid = to.replace(/[^0-9]/g, '') + "@s.whatsapp.net";

    // Enviar mensaje de texto
    await socket.sendMessage(jid, { text: message });

    // Enviar imágenes si existen
    for (const image of images) {
      if (image.url) {
        await socket.sendMessage(jid, {
          image: { url: image.url },
          caption: image.type === 'before' ? 'Estado inicial' : 'Estado final'
        });
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Error en sendMessage:', error);
    throw error;
  }
}

module.exports = {
    sendMessage,
    getConnection,
    initializeConnection
  };