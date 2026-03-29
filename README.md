# MarketMind Proxy

Multi-model pipeline backend for MarketMind Pro.
Runs Perplexity → DeepSeek → Claude server-side to bypass CORS and cut API costs 60–80%.

## How it works

```
Browser → POST /api/research
             ↓
        [Stage 1] Perplexity sonar — live web search
             ↓
        [Stage 2] DeepSeek V3 — parse + structure into JSON
             ↓
        [Stage 3] Claude Haiku/Sonnet — analysis on compact brief
             ↓
        Returns final JSON to browser
```

If Perplexity or DeepSeek keys are missing, the server automatically falls back to Claude-only with web search. Nothing breaks.

---

## Deploy to Railway (recommended, ~2 min)

1. Push this folder to a GitHub repo (just this folder, not the HTML)

2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo

3. Select your repo → Railway auto-detects Node.js

4. Go to **Variables** tab and add:
   ```
   CLAUDE_API_KEY     = sk-ant-api03-...
   PERPLEXITY_API_KEY = pplx-...
   DEEPSEEK_API_KEY   = sk-...
   SERPAPI_KEY        = ...        (optional)
   ```

5. Railway gives you a URL like `https://marketmind-proxy-production.up.railway.app`

6. Paste that URL into MarketMind Pro's **Proxy URL** field and click Connect.

7. Done. All API calls now route through the server.

---

## Deploy to Render (free tier available)

1. Push to GitHub

2. Go to [render.com](https://render.com) → New → Web Service

3. Connect your GitHub repo

4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node

5. Add environment variables (same as Railway above)

6. Click Deploy. Render gives you a URL — paste into MarketMind Pro.

> ⚠️ Render free tier spins down after 15 min idle. First request takes ~30s to wake up. Upgrade to $7/month to avoid this.

---

## Local development

```bash
# Clone / copy this folder
cd marketmind-proxy

# Install deps
npm install

# Copy env template and fill in your keys
cp .env.example .env
# edit .env

# Start with hot reload
npm run dev
# → Server running on http://localhost:3000
```

Test the health endpoint:
```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "keys": { "claude": true, "perplexity": true, "deepseek": true, "serpapi": false },
  "mode": "full-pipeline",
  "cost_estimate": "~$0.010–0.020/module (80% cheaper than Sonnet direct)"
}
```

---

## API Reference

### GET /api/health
Returns server status, which keys are configured, active pipeline mode.

### POST /api/research
Main research endpoint. Runs the full pipeline.

**Request body:**
```json
{
  "sys": "system prompt string",
  "msg": "user message string",
  "tier": "haiku | sonnet",
  "maxTok": 2000
}
```

**Response:**
```json
{
  "data": { ...parsed JSON result... },
  "usage": { "input_tokens": 800, "output_tokens": 1200 },
  "pipeline": "full | perplexity-claude | claude-only | deepseek-fallback",
  "model": "claude-haiku-4-5-20251001"
}
```

### GET /api/trends?q=query
SerpAPI Google Trends proxy. Returns 12-month India trend data.

---

## Cost comparison

| Setup | Per module | Full 11-tab report |
|---|---|---|
| Claude Sonnet direct (old) | ~$0.25–0.30 | ~$2.75–3.30 |
| Claude Haiku direct (v3) | ~$0.015–0.025 | ~$0.16–0.28 |
| Full pipeline via proxy (v4) | ~$0.008–0.015 | ~$0.09–0.17 |

Perplexity sonar: ~$5/1000 requests · DeepSeek V3: ~$0.27/M output tokens
