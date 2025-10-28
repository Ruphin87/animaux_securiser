const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// === PORT fourni par Render.com ===
const PORT = process.env.PORT || 8080;

// === Création du serveur HTTP standard ===
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket sécurisé (WSS) actif sur le port ' + PORT);
});

// === Création du serveur WebSocket sécurisé ===
const wss = new WebSocket.Server({ server });

// === STOCKAGE DES CLIENTS ET FILES D'ATTENTE ===
const clients = {
    android: null,
    espCam: null,
    espStandard: null
};

const photoQueue = [];
const espCamCommandQueue = [];
const espStandardCommandQueue = [];
let espCamConnected = false;
let espStandardConnected = false;

// === FONCTIONS UTILITAIRES ===
function broadcastEspStatus() {
    if (clients.android && clients.android.readyState === WebSocket.OPEN) {
        const statusMessage = {
            type: 'esp_status',
            espCam: espCamConnected,
            espStandard: espStandardConnected,
            connected: espCamConnected
        };
        clients.android.send(JSON.stringify(statusMessage));
        console.log(`[Android] Status ESP: CAM=${espCamConnected}, STD=${espStandardConnected}`);
    }
}

function sendToEspStandard(message) {
    const msg = JSON.stringify(message);
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(msg);
        console.log(`[ESP-Standard] Commande: ${msg}`);
    } else {
        espStandardCommandQueue.push(msg);
        console.log(`[Queue] ESP-Standard hors ligne → commande en attente`);
    }
}

// === GESTION DES CONNEXIONS ===
wss.on('connection', (socket, req) => {
    const clientId = uuidv4();
    socket.clientId = clientId;
    socket.clientType = null;
    const clientIp = req.socket.remoteAddress || 'inconnu';
    const clientPort = req.socket.remotePort || 0;

    console.log(`Connexion: ${clientIp}:${clientPort} (ID: ${clientId})`);

    // Timeout d’enregistrement
    const registrationTimeout = setTimeout(() => {
        if (!socket.clientType) {
            console.log(`[Timeout] Client ${clientId} non enregistré → déconnexion`);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis dans 45s' }));
            }
            socket.close(1000, 'Timeout');
        }
    }, 45000);

    // === GESTION DES MESSAGES ===
    socket.on('message', (data) => {
        try {
            const isBinary = Buffer.isBuffer(data);

            // === PHOTO (BINAIRE) ===
            if (isBinary) {
                // NE JAMAIS FAIRE .toString() sur un JPEG !
                if (socket.clientType === 'esp32-cam') {
                    const size = data.length;
                    if (size < 5000) {
                        console.log(`[Warning] Photo trop petite: ${size} bytes → ignorée`);
                        return;
                    }

                    console.log(`Photo reçue: ${size} bytes de ESP32-CAM (${clientId})`);

                    if (clients.android && clients.android.readyState === WebSocket.OPEN) {
                        clients.android.send(data);  // Buffer brut
                        console.log(`Photo transférée à Android`);
                    } else {
                        photoQueue.push(data);
                        console.log(`Android hors ligne → photo en file (queue: ${photoQueue.length})`);
                    }

                    sendToEspStandard({ type: 'turn_on_light' });
                    return;
                } else {
                    console.log(`[Erreur] Binaire reçu d'un non-CAM`);
                    socket.send(JSON.stringify({ type: 'error', message: 'Seul esp32-cam envoie des photos' }));
                    return;
                }
            }

            // === MESSAGE TEXTE (JSON) ===
            const message = JSON.parse(data.toString());
            console.log(`[JSON] ${socket.clientType || 'Inconnu'} (${clientId}): ${JSON.stringify(message)}`);

            // === REGISTER ===
            if (message.type === 'register') {
                clearTimeout(registrationTimeout);
                const device = message.device;

                if (device === 'android') {
                    clients.android = socket;
                    socket.clientType = 'android';
                    console.log('Android connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();

                    while (photoQueue.length > 0) {
                        const photo = photoQueue.shift();
                        socket.send(photo);
                        console.log(`Photo en attente envoyée à Android`);
                    }

                } else if (device === 'esp32-cam') {
                    clients.espCam = socket;
                    socket.clientType = 'esp32-cam';
                    espCamConnected = true;
                    console.log('ESP32-CAM connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();

                    while (espCamCommandQueue.length > 0) {
                        const cmd = espCamCommandQueue.shift();
                        clients.espCam.send(cmd);
                        console.log(`[Queue] Commande CAM exécutée`);
                    }

                } else if (device === 'esp32-standard') {
                    clients.espStandard = socket;
                    socket.clientType = 'esp32-standard';
                    espStandardConnected = true;
                    console.log('ESP32-Standard connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();

                    while (espStandardCommandQueue.length > 0) {
                        const cmd = espStandardCommandQueue.shift();
                        clients.espStandard.send(cmd);
                        console.log(`[Queue] Commande STD exécutée`);
                    }

                } else {
                    socket.send(JSON.stringify({ type: 'error', message: 'Device inconnu' }));
                    socket.close(1000, 'Device invalide');
                }
                return;
            }

            // === AUTRES MESSAGES ===
            if (message.type === 'alert' && ['esp32-cam', 'esp32-standard'].includes(socket.clientType)) {
                if (clients.android) {
                    clients.android.send(JSON.stringify(message));
                    console.log(`Alerte → Android: ${message.message}`);
                }
                sendToEspStandard({ type: 'turn_on_light' });
            }

            else if (message.type === 'network_config' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                if (clients.espCam) clients.espCam.send(msg);
                else espCamCommandQueue.push(msg);

                if (clients.espStandard) clients.espStandard.send(msg);
                else espStandardCommandQueue.push(msg);

                socket.send(JSON.stringify({ type: 'command_response', success: true, message: 'Config réseau envoyée' }));
            }

            else if (message.type === 'security_config' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                if (clients.espCam) clients.espCam.send(msg);
                else espCamCommandQueue.push(msg);

                if (clients.espStandard) clients.espStandard.send(msg);
                else espStandardCommandQueue.push(msg);

                socket.send(JSON.stringify({ type: 'command_response', success: true, message: 'Sécurité mise à jour' }));
            }

            else if (message.type === 'capture_request' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                if (clients.espCam) clients.espCam.send(msg);
                else espCamCommandQueue.push(msg);
                socket.send(JSON.stringify({ type: 'command_response', success: true, message: 'Capture demandée' }));
            }

            else if (message.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
            }

            else if (message.type === 'command_response' && clients.android) {
                clients.android.send(JSON.stringify(message));
            }

            else {
                socket.send(JSON.stringify({ type: 'error', message: 'Commande inconnue' }));
            }

        } catch (error) {
            console.error(`[Erreur message] ${socket.clientId}:`, error.message);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'error', message: 'Message invalide' }));
            }
        }
    });

    // === DÉCONNEXION ===
    socket.on('close', (code, reason) => {
        console.log(`Déconnexion: ${socket.clientType || 'Inconnu'} (${clientId})`);
        if (socket.clientType === 'android') clients.android = null;
        else if (socket.clientType === 'esp32-cam') {
            clients.espCam = null;
            espCamConnected = false;
            broadcastEspStatus();
        } else if (socket.clientType === 'esp32-standard') {
            clients.espStandard = null;
            espStandardConnected = false;
            broadcastEspStatus();
        }
        clearTimeout(registrationTimeout);
    });

    socket.on('error', (err) => {
        console.error(`[Erreur WS] ${clientId}:`, err.message);
    });
});

// === DÉMARRAGE ===
server.listen(PORT, '0.0.0.0', () => {
    console.log('--- SERVEUR WSS ACTIF ---');
    console.log(`→ wss://animaux-securiser.onrender.com`);
    console.log(`→ Port: ${PORT}`);
});
