import { createClient } from "redis";

const PORT = 3001;

// Map: Redis channel name -> Set of active ServerWebSockets
const subscriptions = new Map<string, Set<any>>();

// 1. Initialize Redis clients
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redisClient = createClient({ url: redisUrl });

await redisClient.connect();
console.log("[WS_SERVER] Connected to Redis.");

const subClient = redisClient.duplicate();
await subClient.connect();

console.log("[WS_SERVER] Listening to Redis Pub/Sub channel pattern depth:*");
await subClient.pSubscribe("depth:*", (message, channel) => {
  console.log(`[WS_SERVER] Received depth update from Redis on channel: ${channel}`);
  const sockets = subscriptions.get(channel);
  if (sockets && sockets.size > 0) {
    console.log(`[WS_SERVER] Broadcasting update to ${sockets.size} subscribed client(s).`);
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch (sendErr) {
        console.error(`[WS_SERVER] Error sending message to socket:`, sendErr);
      }
    }
  }
});

// 3. Start high-performance Bun WebSocket Server
const server = Bun.serve<{ subscribedChannels: Set<string> }>({
  port: PORT,
  fetch(req, server) {
    const upgraded = server.upgrade(req, {
      data: {
        subscribedChannels: new Set<string>(),
      },
    });
    if (upgraded) return undefined;
    return new Response("WebSocket connection upgrade failed.", { status: 400 });
  },
  websocket: {
    open(ws) {
      console.log("[WS_SERVER] Client connected successfully.");
    },
    message(ws, message) {
      try {
        const payload = JSON.parse(message.toString());
        const { method, params, id } = payload;

        if (method === "SUBSCRIBE" && Array.isArray(params)) {
          for (const param of params) {
            // Check param format: e.g. "btc_usdt@depth"
            const parts = param.split("@");
            if (parts.length === 2 && parts[1] === "depth") {
              const symbol = parts[0].toLowerCase();
              const channel = `depth:${symbol}`;

              if (!subscriptions.has(channel)) {
                subscriptions.set(channel, new Set());
              }
              subscriptions.get(channel)!.add(ws);
              ws.data.subscribedChannels.add(channel);

              console.log(`[WS_SERVER] Client subscribed to channel: ${channel}`);
            }
          }
          // Respond with subscription acknowledgment
          ws.send(JSON.stringify({ result: null, id }));
        } else if (method === "UNSUBSCRIBE" && Array.isArray(params)) {
          for (const param of params) {
            const parts = param.split("@");
            if (parts.length === 2 && parts[1] === "depth") {
              const symbol = parts[0].toLowerCase();
              const channel = `depth:${symbol}`;

              subscriptions.get(channel)?.delete(ws);
              ws.data.subscribedChannels.delete(channel);

              console.log(`[WS_SERVER] Client unsubscribed from channel: ${channel}`);
            }
          }
          ws.send(JSON.stringify({ result: null, id }));
        }
      } catch (err) {
        console.error("[WS_SERVER] Failed to process incoming WS message:", err);
      }
    },
    close(ws) {
      console.log("[WS_SERVER] Client disconnected.");
      // Cleanup client subscriptions
      for (const channel of ws.data.subscribedChannels) {
        const sockets = subscriptions.get(channel);
        if (sockets) {
          sockets.delete(ws);
          if (sockets.size === 0) {
            subscriptions.delete(channel);
          }
        }
      }
    },
  },
});

console.log(`[WS_SERVER] Real-time WS server is running on port ${PORT}`);
