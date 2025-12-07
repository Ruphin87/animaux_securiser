const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// === PORT fourni par Render.com ===
const PORT = process.env.PORT || 8080;

// === Création du serveur HTTP standard ===
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket sécurisé (WSS) actif et ecoute sur le port interne ' + PORT);
});

// === Création du serveur WebSocket sécurisé (utilisant le serveur HTTP) ===
const wss = new WebSocket.Server({ server });

// === STOCKAGE DES CLIENTS ET FILES D'ATTENTE ===
const clients = {
    android: null,
    espCam: null,
    espStandard: null
};

// ATTENTION: La photoQueue stockera maintenant des Buffers (données binaires)
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
        console.log(`[Android] Status ESP envoyé: CAM=${espCamConnected}, STD=${espStandardConnected}`);
    }
}

function sendToEspStandard(message) {
    const msg = JSON.stringify(message);
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(msg);
        console.log(`[ESP-Standard] Commande envoyée: ${msg}`);
    } else {
        // Gestion de la file d'attente si déconnecté
        espStandardCommandQueue.push(msg);
        console.log(`[Queue] ESP32-Standard déconnecté. Commande mise en attente.`);
    }
}

// === GESTION DES CONNEXIONS ===
wss.on('connection', (socket, req) => {
    const clientId = uuidv4();
    socket.clientId = clientId;
    socket.clientType = null;
    const clientIp = req.socket.remoteAddress || 'inconnu';
    const clientPort = req.socket.remotePort || 0;

    console.log(`Connexion entrante: ${clientIp}:${clientPort} (ID: ${clientId})`);

    // Timeout d’enregistrement
    const registrationTimeout = setTimeout(() => {
        if (!socket.clientType) {
            console.log(`[Timeout] Client ${clientId} non enregistré → déconnexion`);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis dans les 45s' }));
            }
            socket.close(1000, 'Timeout enregistrement');
        }
    }, 45000);

    // === GESTION DES MESSAGES ===
    socket.on('message', (data) => 
    {
        try {
            let message;
            const isBinary = Buffer.isBuffer(data);

            if (isBinary) {
                const textData = data.toString('utf8');
                try {
                    // Tente l'analyse JSON (pour les JSON envoyés en binaire)
                    message = JSON.parse(textData);
                    console.log(`[JSON via binaire] ${socket.clientType || 'Inconnu'} (${clientId}): ${textData}`);
                } catch (e) {
                    // Ignorer les données binaires non JSON 
                    console.log(`[Erreur] Données binaires illisibles reçues de ${socket.clientType || 'Inconnu'}. Ignorées.`);
                    return;
                }
            } else {
                // === Message texte (JSON) ===
                message = JSON.parse(data.toString());
                console.log(`[JSON] ${socket.clientType || 'Inconnu'} (${clientId}): ${JSON.stringify(message)}`);
            }

            // === TRAITEMENT DES MESSAGES JSON ===
            if (message.type === 'register') {
                clearTimeout(registrationTimeout);
                const device = message.device;

                if (device === 'android') {
                    clients.android = socket;
                    socket.clientType = 'android';
                    console.log('Android connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();
                    
                    // Vider la file d'attente de photos (qui contient maintenant des Buffers binaires)
                    while (photoQueue.length > 0) {
                        const photoBuffer = photoQueue.shift();
                        socket.send(photoBuffer); // Envoi du Buffer (binaire)
                        console.log(`Photo binaire en attente envoyée à Android`);
                    }

                } else if (device === 'esp32-cam') {
                    clients.espCam = socket;
                    socket.clientType = 'esp32-cam';
                    espCamConnected = true;
                    console.log('ESP32-CAM connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();
                    
                    // Exécute les commandes en attente pour l'ESP-CAM
                    while (espCamCommandQueue.length > 0) {
                        const command = espCamCommandQueue.shift();
                        clients.espCam.send(command);
                        console.log(`[Queue] Commande en attente envoyée à ESP32-CAM.`);
                    }

                } else if (device === 'esp32-standard') {
                    clients.espStandard = socket;
                    socket.clientType = 'esp32-standard';
                    espStandardConnected = true;
                    console.log('ESP32-Standard connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();

                    // Exécute les commandes en attente pour l'ESP-Standard
                    while (espStandardCommandQueue.length > 0) {
                        const command = espStandardCommandQueue.shift();
                        clients.espStandard.send(command);
                        console.log(`[Queue] Commande en attente envoyée à ESP32-Standard.`);
                    }

                } else {
                    socket.send(JSON.stringify({ type: 'error', message: 'Device inconnu' }));
                    socket.close(1000, 'Device invalide');
                }
            }

            // 💡 MODIFICATION CLÉ: Décodage Base64 vers Binaire
            else if (message.type === 'image_data' && socket.clientType === 'esp32-cam') {
                const base64Image = message.data;
                
                if (!base64Image) {
                    console.log("[Erreur] Message image_data sans données Base64.");
                    return;
                }
                
                // 1. Décodage de la chaîne Base64 en Buffer binaire
                const imageBuffer = Buffer.from(base64Image, 'base64');
                console.log(`[Image Data] Base64 reçue. Taille binaire pour Android: ${imageBuffer.length} bytes.`);
                
                // 2. Transfert à l'application Android
                if (clients.android && clients.android.readyState === WebSocket.OPEN) {
                    clients.android.send(imageBuffer); // ENVOI DU BUFFER BINAIRE
                    console.log(`Photo Binaire transférée à Android`);
                } else {
                    photoQueue.push(imageBuffer); // Mise en attente du Buffer binaire
                    console.log(`Android hors ligne → image binaire mise en attente (queue: ${photoQueue.length})`);
                }

                // Commande pour allumer la lumière sur l'ESP Standard
                sendToEspStandard({ type: 'turn_on_light' });
            }

            // === COMMANDES ET ALERTES ===
            else if (message.type === 'alert' && ['esp32-cam', 'esp32-standard'].includes(socket.clientType)) {
                // Transfert de l'alerte à l'application Android
                if (clients.android) {
                    clients.android.send(JSON.stringify(message));
                    console.log(`Alerte transférée à Android: ${message.message}`);
                }
                // Commande pour allumer la lumière sur l'ESP Standard
                sendToEspStandard({ type: 'turn_on_light' });
            }

            // L'Android envoie une nouvelle configuration réseau aux ESP
            else if (message.type === 'network_config' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                // CAM
                if (clients.espCam) clients.espCam.send(msg);
                else {
                    espCamCommandQueue.push(msg);
                    console.log(`[Queue] network_config pour CAM mise en attente.`);
                }
                
                // STANDARD
                if (clients.espStandard) clients.espStandard.send(msg);
                else {
                    espStandardCommandQueue.push(msg);
                    console.log(`[Queue] network_config pour STD mise en attente.`);
                }
                
                socket.send(JSON.stringify({ type: 'command_response', success: true, message: `Config réseau envoyée` }));
            }

            // L'Android envoie l'état de sécurité aux ESP
            else if (message.type === 'security_config' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                // CAM
                if (clients.espCam) clients.espCam.send(msg);
                else {
                    espCamCommandQueue.push(msg);
                    console.log(`[Queue] security_config pour CAM mise en attente.`);
                }
                
                // STANDARD
                if (clients.espStandard) clients.espStandard.send(msg);
                else {
                    espStandardCommandQueue.push(msg);
                    console.log(`[Queue] security_config pour STD mise en attente.`);
                }
                
                socket.send(JSON.stringify({ type: 'command_response', success: true, message: `Sécurité mise à jour` }));
            }
            
            // L'Android envoie une commande de capture à l'ESP-CAM
            else if (message.type === 'capture_request' && socket.clientType === 'android') {
                const msg = JSON.stringify(message);
                if (clients.espCam) clients.espCam.send(msg);
                else {
                    espCamCommandQueue.push(msg);
                    console.log(`[Queue] capture_request pour CAM mise en attente.`);
                }
                socket.send(JSON.stringify({ type: 'command_response', success: true, message: `Requête de capture envoyée.` }));
            }

            // Heartbeat
            else if (message.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
            }

            else if (message.type === 'command_response' && clients.android && clients.android.readyState === WebSocket.OPEN) {
                // Transférer la réponse de l'ESP à l'application Android
                clients.android.send(JSON.stringify(message));
            }

            else {
                socket.send(JSON.stringify({ type: 'error', message: 'Commande inconnue' }));
            }

        } catch (error) {
            console.error(`[Erreur message] ${socket.clientId}:`, error.message);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'error', message: 'Erreur serveur interne lors du traitement du message' }));
            }
        }
    });

    // === GESTION DES DÉCONNEXIONS ===
    socket.on('close', (code, reason) => {
        console.log(`Déconnexion: ${socket.clientType || 'Inconnu'} (${clientId}), code=${code}`);
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

// === DÉMARRAGE DU SERVEUR ===
server.listen(PORT, '0.0.0.0', () => {
    console.log('--- SERVEUR WSS ACTIF ---');
    console.log(`→ URL Publique: wss://animaux-securiser.onrender.com`);
    console.log(`→ Port Interne (HTTP): ${PORT}`);
    console.log(`→ Communication améliorée avec Command Queues.`);
});
