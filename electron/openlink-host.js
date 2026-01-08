const WebSocket = require('ws');
let ws;
let reconnecting = false;

function connect() {
    ws = new WebSocket('wss://openlink.raywonderis.me');

    ws.on('open', () => {
        console.log('[' + new Date().toISOString() + '] Connected');
        reconnecting = false;
        ws.send(JSON.stringify({
            type: 'create_session',
            sessionId: 'macmini-fl',
            password: 'connect123'
        }));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('[' + new Date().toISOString() + '] ' + msg.type);
        
        if (msg.type === 'session_created') {
            ws.send(JSON.stringify({ type: 'host', sessionId: 'macmini-fl' }));
        }
        if (msg.type === 'error') {
            ws.send(JSON.stringify({ type: 'host', sessionId: 'macmini-fl' }));
        }
        if (msg.type === 'joined') {
            console.log('Session ACTIVE');
        }
    });

    ws.on('close', () => {
        console.log('Reconnecting...');
        if (!reconnecting) {
            reconnecting = true;
            setTimeout(connect, 5000);
        }
    });

    ws.on('error', (e) => console.error('Error:', e.message));
}

setInterval(() => {
    if (ws && ws.readyState === 1) ws.ping();
}, 30000);

connect();
console.log('Host service started');
