const OPENLINK_EDGE_VERSION = "1.7.27-cloudflare-edge";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/diagnostics/status") {
      return Response.json({
        status: "healthy",
        version: OPENLINK_EDGE_VERSION,
        backend: "cloudflare-durable-object-websocket",
        websocket: "/ws",
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname === "/ws") {
      if (!isAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = env.OPENLINK_EDGE_ROOM.idFromName("global");
      return env.OPENLINK_EDGE_ROOM.get(id).fetch(request);
    }

    return Response.json({
      name: "OpenLink Cloudflare Edge",
      version: OPENLINK_EDGE_VERSION,
      endpoints: {
        health: "/health",
        diagnostics: "/diagnostics/status",
        websocket: "/ws"
      }
    });
  }
};

export class OpenLinkEdgeRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.connections = new Map();

    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() || {};
      const connectionId = attachment.connectionId || crypto.randomUUID();
      this.connections.set(connectionId, { ws, ...attachment });
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({
        status: "ok",
        version: OPENLINK_EDGE_VERSION,
        connections: this.connections.size
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connectionId = crypto.randomUUID();
    const attachment = {
      connectionId,
      connectedAt: Date.now(),
      lastActivity: Date.now()
    };

    server.serializeAttachment(attachment);
    this.state.acceptWebSocket(server);
    this.connections.set(connectionId, { ws: server, ...attachment });

    server.send(JSON.stringify({
      type: "connected",
      connectionId,
      version: OPENLINK_EDGE_VERSION,
      transport: "cloudflare-durable-object-websocket"
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const connection = this.connectionForWebSocket(ws);
    if (!connection) return;

    connection.lastActivity = Date.now();

    let payload;
    try {
      payload = typeof message === "string" ? JSON.parse(message) : JSON.parse(new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      return;
    }

    if (payload.type === "ping") {
      this.registerMachine(connection, payload.machineInfo || payload.hostInfo || payload.clientInfo || {});
      ws.send(JSON.stringify({ type: "pong", timestamp: Date.now(), backend: "cloudflare-edge" }));
      return;
    }

    if (payload.type === "create_session" || payload.type === "create-session" || payload.type === "handshake" || payload.type === "client-info" || payload.type === "machine_presence") {
      this.registerMachine(connection, payload.machineInfo || payload.hostInfo || payload.clientInfo || payload);
      ws.send(JSON.stringify({
        type: payload.type === "handshake" ? "handshake_ack" : "session_created",
        sessionId: payload.sessionId || connection.sessionId || `cf-${connection.connectionId.slice(0, 8)}`,
        connectionId: connection.connectionId,
        backend: "cloudflare-edge"
      }));
      return;
    }

    const target = canonicalToken(payload.targetMachineId || payload.targetMachineName || payload.targetId || payload.to);
    const targetConnection = this.findTarget(target);
    if (targetConnection) {
      targetConnection.ws.send(JSON.stringify({
        ...payload,
        routedVia: "cloudflare-edge",
        fromConnectionId: connection.connectionId,
        sourceMachineId: payload.sourceMachineId || connection.machineId,
        sourceMachineName: payload.sourceMachineName || connection.machineName,
        sourcePlatform: payload.sourcePlatform || connection.platform
      }));
      return;
    }

    ws.send(JSON.stringify({
      type: `${payload.type || "message"}_ack`,
      success: false,
      error: "target_machine_not_found",
      targetMachineId: payload.targetMachineId || null,
      backend: "cloudflare-edge"
    }));
  }

  async webSocketClose(ws) {
    this.removeWebSocket(ws);
  }

  async webSocketError(ws) {
    this.removeWebSocket(ws);
  }

  registerMachine(connection, info) {
    const aliases = Array.isArray(info.aliases) ? info.aliases : [];
    connection.machineId = info.id || info.machineId || connection.machineId || connection.connectionId;
    connection.machineName = info.displayName || info.machineName || info.hostname || connection.machineName || connection.machineId;
    connection.platform = info.platform || info.os || connection.platform || "Unknown";
    connection.aliases = [...new Set([connection.machineId, connection.machineName, info.hostname, ...aliases].filter(Boolean))];
    connection.ws.serializeAttachment({
      connectionId: connection.connectionId,
      connectedAt: connection.connectedAt,
      lastActivity: connection.lastActivity,
      machineId: connection.machineId,
      machineName: connection.machineName,
      platform: connection.platform,
      aliases: connection.aliases
    });
  }

  findTarget(token) {
    if (!token) return null;
    for (const connection of this.connections.values()) {
      const candidates = [connection.machineId, connection.machineName, ...(connection.aliases || [])];
      if (candidates.some(candidate => canonicalToken(candidate) === token)) {
        return connection;
      }
    }
    return null;
  }

  connectionForWebSocket(ws) {
    for (const connection of this.connections.values()) {
      if (connection.ws === ws) return connection;
    }
    const attachment = ws.deserializeAttachment() || {};
    if (!attachment.connectionId) return null;
    const restored = { ws, ...attachment };
    this.connections.set(attachment.connectionId, restored);
    return restored;
  }

  removeWebSocket(ws) {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.ws === ws) {
        this.connections.delete(connectionId);
        return;
      }
    }
  }
}

function isAuthorized(request, env) {
  if (!env.OPENLINK_EDGE_SHARED_TOKEN) return true;
  const header = request.headers.get("Authorization") || "";
  return header === env.OPENLINK_EDGE_SHARED_TOKEN || header === `Bearer ${env.OPENLINK_EDGE_SHARED_TOKEN}`;
}

function canonicalToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
