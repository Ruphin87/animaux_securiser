const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// =======================================================
// === CONFIGURATION DU SERVEUR ===
// =======================================================

// PORT : Utilise le port fourni par l'environnement (ex: Render.com) ou 8080 par défaut
const PORT = process.env.PORT || 8080;

// === Création du serveur HTTP standard ===
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Serveur WebSocket sécurisé (WSS) actif et ecoute sur le port interne ' + PORT);
});

// === Création du serveur WebSocket (utilisant le serveur HTTP) ===
const wss = new WebSocket.Server({ server });

// =======================================================
// === STOCKAGE DES CLIENTS ET FILES D'ATTENTE ===
// =======================================================
const clients = {
    android: null,
    espCam: null,
    espStandard: null
};

// Files d'attente pour la résilience
const photoQueue = []; // Stocke les Buffers binaires des photos si Android est déconnecté
const espCamCommandQueue = []; 
const espStandardCommandQueue = []; 

let espCamConnected = false;
let espStandardConnected = false;

// =======================================================
// === FONCTIONS UTILITAIRES ===
// =======================================================

/**
 * Envoie l'état de connexion des ESP à l'application Android.
 */
function broadcastEspStatus() {
    if (clients.android && clients.android.readyState === WebSocket.OPEN) {
        const statusMessage = {
            type: 'esp_status',
            espCam: espCamConnected,
            espStandard: espStandardConnected,
            connected: espCamConnected // Pour compatibilité
        };
        clients.android.send(JSON.stringify(statusMessage));
        console.log(`[Android] Status ESP envoyé: CAM=${espCamConnected}, STD=${espStandardConnected}`);
    }
}

/**
 * Envoie un message à l'ESP standard, en le mettant en file d'attente si déconnecté.
 * @param {object} message - L'objet JSON à envoyer.
 */
function sendToEspStandard(message) {
    const msg = JSON.stringify(message);
    if (clients.espStandard && clients.espStandard.readyState === WebSocket.OPEN) {
        clients.espStandard.send(msg);
        console.log(`[ESP-Standard] Commande envoyée: ${msg}`);
    } else {
        espStandardCommandQueue.push(msg);
        console.log(`[Queue] ESP32-Standard déconnecté. Commande mise en attente.`);
    }
}

// =======================================================
// === GESTION DES CONNEXIONS ET MESSAGES ===
// =======================================================
wss.on('connection', (socket, req) => {
    const clientId = uuidv4();
    socket.clientId = clientId;
    socket.clientType = null;
    const clientIp = req.socket.remoteAddress || 'inconnu';
    
    console.log(`Connexion entrante: ${clientIp} (ID: ${clientId})`);

    // Timeout d’enregistrement (45 secondes)
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
    socket.on('message', (data) => {
        try {
            let message;
            const isBinary = Buffer.isBuffer(data);
            
            // --- GESTION DES DONNÉES BINAIRES ---
            if (isBinary) {
                // Selon le nouveau protocole, les données binaires brutes NE SONT PLUS utilisées par l'ESP-CAM.
                // Seul le serveur envoie du binaire (photos) à Android.
                console.log(`[Erreur Protocole] Données binaires brutes reçues de ${socket.clientType || 'Inconnu'}. Attendu: JSON texte.`);
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'error', message: 'Protocole changé. Envoyer l\'image en Base64 dans un JSON TEXTE.' }));
                }
                return;
            } else {
                // --- GESTION DES MESSAGES TEXTE (JSON) ---
                message = JSON.parse(data.toString());
                // console.log(`[JSON] ${socket.clientType || 'Inconnu'} (${clientId}): ${JSON.stringify(message)}`);
            }

            // ===============================================
            // === TRAITEMENT DES MESSAGES JSON ===
            // ===============================================

            // --- Enregistrement (Obligatoire) ---
            if (message.type === 'register') {
                clearTimeout(registrationTimeout);
                const device = message.device;

                if (device === 'android') {
                    clients.android = socket;
                    socket.clientType = 'android';
                    console.log('Android connecté');
                    socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
                    broadcastEspStatus();
                    
                    // Vider la file d'attente de photos
                    while (photoQueue.length > 0) {
                        const photoBuffer = photoQueue.shift();
                        socket.send(photoBuffer); // Envoi du Buffer Binaire
                        console.log(`Photo en attente (binaire, ${photoBuffer.length} bytes) envoyée à Android`);
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
            
            // --- GESTION DE LA PHOTO (Base64 -> Binaire) ---
            else if (message.type === 'image_data' && socket.clientType === 'esp32-cam') {
                const base64Image = message.data;
                const triggerType = message.trigger || 'Inconnu';
                const isSuccess = message.success === true;

                if (!base64Image || !isSuccess) {
                    console.error('[Erreur Image] Données Base64 manquantes ou succès=false.');
                    return;
                }

                // 1. Conversion de la chaîne Base64 en Buffer binaire (JPEG)
                const photoBuffer = Buffer.from(base64Image, 'base64');
                
                console.log(`Photo Base64 décodée (${photoBuffer.length} bytes) de ESP32-CAM. Déclencheur: ${triggerType}`);
                
                // 2. Transférer l'image binaire (Buffer) à Android
                if (clients.android && clients.android.readyState === WebSocket.OPEN) {
                    clients.android.send(photoBuffer); // Envoi binaire (Buffer)
                    console.log(`Photo binaire transférée à Android`);
                } else {
                    // 3. Mise en attente du Buffer binaire
                    photoQueue.push(photoBuffer); 
                    console.log(`Android hors ligne → photo binaire mise en attente (queue: ${photoQueue.length})`);
                }
                
                // Commande pour allumer la lumière sur l'ESP Standard
                sendToEspStandard({ type: 'turn_on_light' });
            }


            // --- COMMANDES ET ALERTES ---
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
                // Mise à jour de la configuration réseau sur les deux ESP
                if (clients.espCam) clients.espCam.send(data.toString());
                if (clients.espStandard) sendToEspStandard(message);
                console.log(`Config réseau envoyée aux ESP.`);
            }

            // L'Android envoie l'état de sécurité aux ESP
            else if (message.type === 'security_config' && socket.clientType === 'android') {
                // Mise à jour de l'état de sécurité sur les deux ESP
                if (clients.espCam) clients.espCam.send(data.toString());
                if (clients.espStandard) sendToEspStandard(message);
                console.log(`Config sécurité envoyée aux ESP.`);
            }
            
            // L'Android envoie une commande de capture à l'ESP-CAM
            else if (message.type === 'capture_request' && socket.clientType === 'android') {
                if (clients.espCam) {
                    clients.espCam.send(data.toString());
                    console.log(`Commande de capture envoyée à ESP32-CAM.`);
                } else {
                    // Mise en file d'attente si l'ESP-CAM est déconnecté
                    espCamCommandQueue.push(data.toString());
                    console.log(`[Queue] ESP32-CAM déconnecté. Commande de capture mise en attente.`);
                    clients.android.send(JSON.stringify({ type: 'command_response', success: false, message: 'ESP32-CAM déconnecté, commande mise en attente.' }));
                }
            }

            // Heartbeat
            else if (message.type === 'ping') {
                socket.send(JSON.stringify({ type: 'pong' }));
            }

            // Transfert de la réponse d'une commande de l'ESP à l'application Android
            else if (message.type === 'command_response' && clients.android && clients.android.readyState === WebSocket.OPEN) {
                clients.android.send(JSON.stringify(message));
            }

            else {
                console.log(`[Erreur JSON] Commande inconnue: ${message.type}`);
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

// =======================================================
// === DÉMARRAGE DU SERVEUR ===
// =======================================================
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur WebSocket démarré sur le port ${PORT}`);
    console.log('Prêt à recevoir les connexions ESP et Android...');
});
