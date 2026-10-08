import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { DurableObject } from 'cloudflare:workers';

type Bindings = {
  DB: D1Database;
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
};

interface ScoreEntry {
  id: number;
  player_name: string;
  score: number;
  created_at: string;
}

interface PlayerState {
  id: string;
  name: string;
  x: number;
}

// -------------------------------------------------------------
// Durable Object: GameRoom (WebSocket Coordination)
// -------------------------------------------------------------
export class GameRoom extends DurableObject {
  private players: Map<string, PlayerState> = new Map();

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const playerName = (url.searchParams.get('name') || 'Pilot').substring(0, 16);
    const playerId = crypto.randomUUID().substring(0, 8);

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);

    // Accept using Hibernation API and attach metadata tags
    this.ctx.acceptWebSocket(serverSocket, [playerId]);
    serverSocket.serializeAttachment({ id: playerId, name: playerName });

    this.players.set(playerId, { id: playerId, name: playerName, x: 425 });

    // Send the joining player their assigned ID
    serverSocket.send(JSON.stringify({
      type: 'INIT',
      selfId: playerId
    }));

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message as string);
      const attachment = ws.deserializeAttachment() as { id: string; name: string };
      if (!attachment) return;

      if (data.type === 'POS' && typeof data.x === 'number') {
        const player = this.players.get(attachment.id);
        if (player) {
          player.x = Math.max(0, Math.min(960, data.x));
        }

        // Broadcast active player locations to all connected peers
        const statePayload = JSON.stringify({
          type: 'PEERS',
          players: Array.from(this.players.values())
        });

        for (const client of this.ctx.getWebSockets()) {
          try {
            client.send(statePayload);
          } catch (e) {}
        }
      }
    } catch (err) {
      // Ignore malformed client packets
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const attachment = ws.deserializeAttachment() as { id: string; name: string };
    if (attachment) {
      this.players.delete(attachment.id);

      const disconnectPayload = JSON.stringify({
        type: 'LEAVE',
        id: attachment.id
      });

      for (const client of this.ctx.getWebSockets()) {
        try {
          client.send(disconnectPayload);
        } catch (e) {}
      }
    }
  }
}

// -------------------------------------------------------------
// Hono Worker: HTTP Router & DB API
// -------------------------------------------------------------
const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// GET: Connect to real-time multiplayer room via WebSocket
app.get('/api/room', async (c) => {
  const roomId = c.req.query('room') || 'global-arena';
  const id = c.env.GAME_ROOM.idFromName(roomId);
  const roomStub = c.env.GAME_ROOM.get(id);
  return roomStub.fetch(c.req.raw);
});

// GET: Top 10 High Scores from D1
app.get('/api/scores', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, player_name, score, created_at FROM scores ORDER BY score DESC LIMIT 10'
    ).all<ScoreEntry>();

    return c.json({ success: true, scores: results });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

// POST: Submit a Player Score to D1
app.post('/api/scores', async (c) => {
  try {
    const body = await c.req.json<{ player_name: string; score: number }>();

    if (!body.player_name || typeof body.score !== 'number') {
      return c.json({ success: false, error: 'Invalid payload' }, 400);
    }

    const sanitizedName = body.player_name.trim().substring(0, 24);

    const result = await c.env.DB.prepare(
      'INSERT INTO scores (player_name, score) VALUES (?, ?)'
    )
      .bind(sanitizedName, body.score)
      .run();

    return c.json({
      success: true,
      message: 'Score recorded',
      meta: {
        id: result.meta.last_row_id,
        changes: result.meta.changes
      }
    }, 201);
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

export default app;