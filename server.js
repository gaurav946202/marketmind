import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const app = express();

// ─── KEYS FROM ENVIRONMENT ───────────────────────────────────────────────────
const CLAUDE_KEY     = process.env.CLAUDE_API_KEY     || '';
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY || '';
const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY   || '';
const SERPAPI_KEY    = process.env.SERPAPI_KEY         || '';

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Rate limit: 60 requests per 15 min per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down.' }
});
app.use('/api/', limiter);

// ─── MODELS ──────────────────────────────────────────────────────────────────
const MDL_HAIKU  = 'claude-haiku-4-5-20251001';
const MDL_SONNET = 'claude-sonnet-4-20250514';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function parseJSON(raw) {
  raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
  let best = null, depth = 0, start = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] === '}') { if (depth === 0) start = i; depth++; }
    else if (raw[i] === '{') {
      depth--;
      if (depth === 0 && start !== -1) { best = raw.substring(i, start + 1); break; }
    }
  }
  if (!best) {
    const si = raw.indexOf('{'), ei = raw.lastIndexOf('}');
    if (si !== -1 && ei !== -1) best = raw.substring(si, ei + 1);
  }
  return JSON.parse(best);
}

// ─── STAGE 1: PERPLEXITY (live web search) ───────────────────────────────────
async function searchPerplexity(query) {
  const r = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PERPLEXITY_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        {
          role: 'system',
          content: 'You are a market research data collector specialising in Indian D2C and consumer markets. Return concise, factual, cited market data. Focus on India. No fluff, no preamble.'
        },
        { role: 'user', content: query }
      ],
      max_tokens: 2000,
      search_recency_filter: 'month'
    })
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error('Perplexity: ' + (e?.error?.message || `HTTP ${r.status}`));
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

// ─── STAGE 2: DEEPSEEK (parse + structure into JSON) ─────────────────────────
async function structureDeepSeek(rawData, schema, topic) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPSEEK_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are a data structuring engine. Extract and organize research text into clean JSON. Return ONLY valid JSON. No markdown, no code fences, no explanation.'
        },
        {
          role: 'user',
          content: `Topic: ${topic}\n\nRaw research data:\n${rawData}\n\nFill this JSON schema with real extracted values:\n${schema}\n\nReturn ONLY the filled JSON object.`
        }
      ],
      max_tokens: 3000,
      temperature: 0.1
    })
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error('DeepSeek: ' + (e?.error?.message || `HTTP ${r.status}`));
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '{}';
}

// ─── STAGE 3: CLAUDE (analysis on compact structured brief) ──────────────────
async function analyzeClaude(sys, msg, model, maxTokens, useWebSearch = true) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: sys,
    messages: [{ role: 'user', content: msg }]
  };
  // Only enable web search when not already fed structured data
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.error?.message || `HTTP ${r.status}`);
  }
  return r.json();
}

// ─── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const hasFull    = !!(CLAUDE_KEY && PERPLEXITY_KEY && DEEPSEEK_KEY);
  const hasPartial = !!(CLAUDE_KEY && PERPLEXITY_KEY);
  res.json({
    status: 'ok',
    keys: {
      claude:     !!CLAUDE_KEY,
      perplexity: !!PERPLEXITY_KEY,
      deepseek:   !!DEEPSEEK_KEY,
      serpapi:    !!SERPAPI_KEY
    },
    mode: hasFull ? 'full-pipeline' : hasPartial ? 'perplexity-claude' : 'claude-only',
    cost_estimate: hasFull
      ? '~$0.010–0.020/module (80% cheaper than Sonnet direct)'
      : hasPartial
      ? '~$0.015–0.025/module'
      : '~$0.015–0.030/module'
  });
});

// ─── POST /api/research ───────────────────────────────────────────────────────
// Main pipeline endpoint — handles all 3 stages server-side
app.post('/api/research', async (req, res) => {
  const { sys, msg, tier, maxTok } = req.body;
  if (!sys || !msg) return res.status(400).json({ error: 'Missing sys or msg' });
  if (!CLAUDE_KEY)  return res.status(500).json({ error: 'CLAUDE_API_KEY not set on server' });

  const model     = tier === 'sonnet' ? MDL_SONNET : MDL_HAIKU;
  const maxTokens = maxTok || 2000;
  const cleanMsg  = msg.replace(/Return only JSON\./gi, '').replace(/Return ONLY the JSON\./gi, '').trim();

  // ── FULL PIPELINE: Perplexity → DeepSeek → Claude ─────────────────────────
  if (PERPLEXITY_KEY && DEEPSEEK_KEY) {
    try {
      console.log(`[PIPELINE] Full · ${cleanMsg.substring(0, 60)}...`);

      // Stage 1
      const rawData = await searchPerplexity(cleanMsg);
      console.log(`[STAGE 1] Perplexity OK · ${rawData.length} chars`);

      // Stage 2
      const schemaMatch = sys.match(/\{[\s\S]*\}/);
      const schema = schemaMatch ? schemaMatch[0] : '{}';
      const structured = await structureDeepSeek(rawData, schema, cleanMsg);
      console.log(`[STAGE 2] DeepSeek OK · ${structured.length} chars`);

      // Stage 3 — Claude on compact, pre-structured brief (no web search needed)
      const claudeMsg = `You have been given pre-researched, structured market data for: "${cleanMsg}".\n\nStructured research brief (from live web + DeepSeek):\n${structured}\n\nUsing this data as your base, produce the final analysis JSON. Keep all numerical figures accurate. Add strategic insights where the brief lacks depth.\n\nReturn ONLY the JSON.`;
      const d = await analyzeClaude(sys, claudeMsg, model, maxTokens, false); // no web search
      let raw = '';
      for (const b of (d.content || [])) if (b.type === 'text') raw += b.text;

      try {
        return res.json({ data: parseJSON(raw), usage: d.usage, pipeline: 'full', model });
      } catch {
        console.warn('[STAGE 3] Claude JSON parse failed — using DeepSeek output');
        return res.json({ data: parseJSON(structured), usage: {}, pipeline: 'deepseek-fallback', model });
      }
    } catch (e) {
      console.error(`[PIPELINE] Full pipeline error: ${e.message} — falling back`);
      // Fall through
    }
  }

  // ── PARTIAL PIPELINE: Perplexity → Claude ─────────────────────────────────
  if (PERPLEXITY_KEY && !DEEPSEEK_KEY) {
    try {
      console.log(`[PIPELINE] Perplexity+Claude · ${cleanMsg.substring(0, 60)}...`);
      const rawData = await searchPerplexity(cleanMsg);
      const claudeMsg = `Live web research data collected for this topic:\n${rawData}\n\nNow produce the analysis. ${msg}`;
      const d = await analyzeClaude(sys, claudeMsg, model, maxTokens, false);
      let raw = '';
      for (const b of (d.content || [])) if (b.type === 'text') raw += b.text;
      return res.json({ data: parseJSON(raw), usage: d.usage, pipeline: 'perplexity-claude', model });
    } catch (e) {
      console.error(`[PIPELINE] Perplexity+Claude error: ${e.message} — falling back`);
    }
  }

  // ── CLAUDE-ONLY FALLBACK ───────────────────────────────────────────────────
  try {
    console.log(`[PIPELINE] Claude-only · ${cleanMsg.substring(0, 60)}...`);
    const d = await analyzeClaude(sys, msg, model, maxTokens, true); // with web search
    let raw = '';
    for (const b of (d.content || [])) if (b.type === 'text') raw += b.text;
    return res.json({ data: parseJSON(raw), usage: d.usage, pipeline: 'claude-only', model });
  } catch (e) {
    console.error(`[PIPELINE] Claude-only error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/trends ─────────────────────────────────────────────────────────
// SerpAPI proxy — avoids CORS on client
app.get('/api/trends', async (req, res) => {
  const { q } = req.query;
  if (!q)           return res.status(400).json({ error: 'Missing query param q' });
  if (!SERPAPI_KEY) return res.status(400).json({ error: 'SERPAPI_KEY not configured on server' });
  try {
    const url = `https://serpapi.com/search.json?engine=google_trends&q=${encodeURIComponent(q)}&date=today+12-m&geo=IN&api_key=${SERPAPI_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SerpAPI HTTP ${r.status}`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const hasPplx = !!PERPLEXITY_KEY, hasDs = !!DEEPSEEK_KEY;
  const mode = hasPplx && hasDs ? 'FULL PIPELINE (Perplexity → DeepSeek → Claude)'
             : hasPplx           ? 'PARTIAL (Perplexity → Claude)'
             :                     'CLAUDE ONLY';
  console.log(`\n🚀 MarketMind Proxy — port ${PORT}`);
  console.log(`⚡ Mode: ${mode}`);
  console.log(`🔑 Claude: ${CLAUDE_KEY ? '✅' : '❌'}  Perplexity: ${hasPplx ? '✅' : '❌'}  DeepSeek: ${hasDs ? '✅' : '❌'}  SerpAPI: ${!!SERPAPI_KEY ? '✅' : '❌'}\n`);
});
