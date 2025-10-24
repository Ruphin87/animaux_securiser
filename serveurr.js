const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Serveur WebSocket actif - Port: ' + PORT);
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

  const timeout = setTimeout(() => {
    if (!socket.clientType && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'error', message: 'Enregistrement requis' }));
      socket.close(1000, 'Timeout');
    }
  }, 45000);

  socket.on('message', (data) => {
    try {
      // === 1. PHOTO BINAIRE (ESP32-CAM) ===
      if (Buffer.isBuffer(data)) {
        if (socket.clientType === 'esp32-cam') {
          console.log(`Photo reçue: ${data.length} bytes`);

          if (clients.android && clients.android.readyState === WebSocket.OPEN) {
            clients.android.send(data); // Envoi binaire
          } else {
            photoQueue.push(data);
          }
          return;
        } else {
          console.log(`[ERREUR] Binaire reçu de ${socket.clientType || 'Inconnu'}`);
          return;
        }
      }

      // === 2. MESSAGE TEXTE (JSON) ===
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (e) {
        console.log(`[ERREUR] JSON invalide: ${data.toString()}`);
        return;
      }

      console.log(`[JSON] ${socket.clientType || 'Inconnu'}:`, message);

      // === ENREGISTREMENT ===
      if (message.type === 'register') {
        clearTimeout(timeout);
        const device = message.device;

        if (device === 'android') {
          clients.android = socket;
          socket.clientType = 'android';
          socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
          while (photoQueue.length > 0) {
            socket.send(photoQueue.shift());
          }
        } else if (device === 'esp32-cam') {
          clients.espCam = socket;
          socket.clientType = 'esp32-cam';
          espCamConnected = true;
          socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
          broadcastEspStatus();
        } else if (device === 'esp32-standard') {
          clients.espStandard = socket;
          socket.clientType = 'esp32-standard';
          socket.send(JSON.stringify({ type: 'registered', message: 'OK' }));
          broadcastEspStatus();
        } else {
          socket.send(JSON.stringify({ type: 'error', message: 'Device inconnu' }));
        }
      }

      // === HEARTBEAT ===
      else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }

      // === ALERTES ===
      else if (message.type === 'alert' && socket.clientType?.includes('esp')) {
        if (clients.android) {
          clients.android.send(JSON.stringify(message));
        }
      }

      // === COMMANDES ANDROID → ESP ===
      else if (message.type === 'network_config' && socket.clientType === 'android') {
        const msg = JSON.stringify(message);
        if (clients.espCam) clients.espCam.send(msg);
        if (clients.espStandard) clients.espStandard.send(msg);
      }

      else if (message.type === 'security_config' && socket.clientType === 'android') {
        const msg = JSON.stringify(message);
        if (clients.espCam) clients.espCam.send(msg);
        if (clients.espStandard) clients.espStandard.send(msg);
      }

    } catch (error) {
      console.error(`[ERREUR] ${clientId}:`, error.message);
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
