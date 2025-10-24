const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Serveur WebSocket actif');
});

const wss = new WebSocket.Server({ server, path: '/' });

const clients = { android: null, espCam: null, espStandard: null };
const photoQueue = [];
let espCamConnected = false;

// === BROADCAST STATUS ===
function broadcastEspStatus() {
  if (clients.android && clients.android.readyState === WebSocket.OPEN) {
    clients.android.send(JSON.stringify({
      type: 'esp_status',
      espCam: espCamConnected,
      connected: espCamConnected
    }));
  }
}

// === GESTION CONNEXION ===
wss.on('connection', (socket, req) => {
  const clientId = uuidv4();
  socket.clientId = clientId;
  socket.clientType = null;

  console.log(`[Connexion] ${req.socket.remoteAddress} (ID: ${clientId})`);

  // Timeout d'enregistrement
  const timeout = setTimeout(() => {
    if (!socket.clientType && socket.readyState === WebSocket.OPEN) {
      console.log(`[Timeout] Client ${clientId} non enregistré`);
      socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis dans 45s' }));
      socket.close(1000, 'Timeout enregistrement');
    }
  }, 45000);

  socket.on('message', (data) => {
    try {
      // === 1. IGNORER LES MESSAGES VIDES ===
      if (!data || data.length === 0) {
        console.log(`[IGNORÉ] Message vide de ${clientId}`);
        return;
      }

      // === 2. PHOTO BINAIRE (ESP32-CAM UNIQUEMENT) ===
      if (Buffer.isBuffer(data)) {
        if (socket.clientType === 'esp32-cam') {
          console.log(`Photo reçue: ${data.length} bytes`);
          if (clients.android && clients.android.readyState === WebSocket.OPEN) {
            clients.android.send(data);
          } else {
            photoQueue.push(data);
            console.log(`Photo en file d'attente (${photoQueue.length})`);
          }
        } else {
          console.log(`[ERREUR] Binaire reçu de ${socket.clientType || 'Inconnu'}`);
        }
        return;
      }

      // === 3. MESSAGE TEXTE (JSON) ===
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (e) {
        console.log(`[ERREUR] JSON invalide: ${data.toString()}`);
        return;
      }

      console.log(`[JSON] ${socket.clientType || 'Inconnu'}:`, message);

      // === ENREGISTREMENT OBLIGATOIRE ===
      if (message.type === 'register') {
        clearTimeout(timeout);
        const device = message.device;

        if (device === 'android') {
          if (clients.android) clients.android.close(1000, 'Remplacé');
          clients.android = socket;
          socket.clientType = 'android';
          socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
          while (photoQueue.length > 0) {
            socket.send(photoQueue.shift());
          }
          console.log('Android enregistré');
        } 
        else if (device === 'esp32-cam') {
          clients.espCam = socket;
          socket.clientType = 'esp32-cam';
          espCamConnected = true;
          socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
          broadcastEspStatus();
          console.log('ESP32-CAM enregistré');
        } 
        else if (device === 'esp32-standard') {
          clients.espStandard = socket;
          socket.clientType = 'esp32-standard';
          socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
          broadcastEspStatus();
        } 
        else {
          socket.send(JSON.stringify({ type: 'error', message: 'Device inconnu' }));
        }
      }

      // === COMMANDE UNIQUEMENT APRÈS ENREGISTREMENT ===
      else if (!socket.clientType) {
        console.log(`[ERREUR] Commande avant enregistrement`);
        socket.send(JSON.stringify({ type: 'error', message: 'Enregistrez-vous d\'abord' }));
      }

      // === COMMANDES ANDROID →
      else if (message.type === 'network_config' && socket.clientType === 'android') {
        const msg = JSON.stringify(message);
        if (clients.espCam) clients.espCam.send(msg);
        if (clients.espStandard) clients.espStandard.send(msg);
        socket.send(JSON.stringify({ type: 'command_response', success: true, message: 'Config envoyée' }));
      }

      else if (message.type === 'security_config' && socket.clientType === 'android') {
        const msg = JSON.stringify(message);
        if (clients.espCam) clients.espCam.send(msg);
        if (clients.espStandard) clients.espStandard.send(msg);
        socket.send(JSON.stringify({ type: 'command_response', success: true, message: 'Sécurité mise à jour' }));
      }

      // === HEARTBEAT ===
      else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }

      // === ALERTES ESP →
      else if (message.type === 'alert' && socket.clientType?.includes('esp')) {
        if (clients.android) {
          clients.android.send(JSON.stringify(message));
        }
      }

    } catch (error) {
      console.error(`[CRASH] ${clientId}:`, error.message);
    }
  });

  socket.on('close', (code, reason) => {
    console.log(`[Déconnexion] ${socket.clientType || 'Inconnu'} (${clientId}), code=${code}`);
    if (socket === clients.android) clients.android = null;
    if (socket === clients.espCam) { clients.espCam = null; espCamConnected = false; broadcastEspStatus(); }
    if (socket === clients.espStandard) clients.espStandard = null;
    clearTimeout(timeout);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('SERVEUR WEBSOCKET ACTIF');
  console.log(`URL: wss://animaux-securiser.onrender.com`);
  console.log(`Port interne: ${PORT}`);
});
