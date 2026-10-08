import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
};

interface ScoreEntry {
  id: number;
  player_name: string;
  score: number;
  created_at: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS so your web game hosted on another domain can hit this API
app.use('*', cors());

// Health Check
app.get('/api/health', (c) => {
  return c.json({ status: 'ok', runtime: 'workerd' });
});

// GET: Fetch Top 10 High Scores
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

// POST: Submit a Player Score
app.post('/api/scores', async (c) => {
  try {
    const body = await c.req.json<{ player_name: string; score: number }>();

    if (!body.player_name || typeof body.score !== 'number') {
      return c.json({ success: false, error: 'Invalid payload: player_name (string) and score (number) required.' }, 400);
    }

    const sanitizedName = body.player_name.trim().substring(0, 24);

    const result = await c.env.DB.prepare(
      'INSERT INTO scores (player_name, score) VALUES (?, ?)'
    )
      .bind(sanitizedName, body.score)
      .run();

    return c.json({
      success: true,
      message: 'Score recorded successfully',
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