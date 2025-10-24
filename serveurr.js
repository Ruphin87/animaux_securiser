const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;

// === CRÉATION DU SERVEUR HTTP ===
const server = http.createServer((req, res) => {
  res.writeCORS = function() {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };

  if (req.method === 'OPTIONS') {
    res.writeCORS();
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeCORS();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  res.writeCORS();
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Serveur WebSocket actif (HTTP) - Port: ' + PORT);
});

// === CRÉATION DU WEBSOCKET SERVER (HTTP) ===
const wss = new WebSocket.Server({ 
  server,
  path: '/'  // IMPORTANT : chemin exact
});

// === GESTION DES CLIENTS ===
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
      let message;
      const isBinary = Buffer.isBuffer(data);

      if (isBinary) {
        if (socket.clientType === 'esp32-cam') {
          console.log(`Photo reçue: ${data.length} bytes`);
          if (clients.android && clients.android.readyState === WebSocket.OPEN) {
            clients.android.send(data);
          } else {
            photoQueue.push(data);
          }
          return;
        }
      } else {
        message = JSON.parse(data.toString());
        console.log(`[JSON] ${socket.clientType || 'Inconnu'}:`, message);
      }

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
        }

      } else if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }

    } catch (e) {
      console.error("Erreur message:", e.message);
    }
  });

  socket.on('close', () => {
    console.log(`[Déconnexion] ${socket.clientType || 'Inconnu'} (${clientId})`);
    if (socket === clients.android) clients.android = null;
    if (socket === clients.espCam) { clients.espCam = null; espCamConnected = false; broadcastEspStatus(); }
    clearTimeout(timeout);
  });
});

// === DÉMARRAGE ===
server.listen(PORT, '0.0.0.0', () => {
  console.log('SERVEUR WEBSOCKET ACTIF');
  console.log(`URL: wss://animaux-securiser.onrender.com`);
  console.log(`Port interne: ${PORT}`);
});
