const express = require("express");
const fetch = require("node-fetch");
const Pusher = require("pusher");
const { Redis } = require("@upstash/redis");
const cors = require("cors");
const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000" }));
app.use(express.json());

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function loadTokens() {
  try {
    console.log("Loading tokens from Solscan...");
    const response = await fetch("https://api.solscan.io/v2/token/list?sortBy=created_at&direction=desc&limit=50");
    if (!response.ok) throw new Error(`Solscan API error: ${response.status}`);
    const tokens = await response.json();
    const newTokens = tokens.data
      .filter(t => (Date.now() - new Date(t.created_at).getTime()) < 12 * 3600 * 1000)
      .map(t => ({
        name: t.name || "Unknown",
        address: t.address,
        age: Math.floor((Date.now() - new Date(t.created_at).getTime()) / 3600000) + "h",
        marketCap: 0,
        volume: 0,
        hypeScore: 0,
        xMentions: 0
      }));
    console.log(`Found ${newTokens.length} new tokens`);
    await Promise.all(newTokens.map(updateTokenData));
    await redis.set("newTokens", rankTokens(newTokens).slice(0, 5));
    const featuredExists = await redis.exists("featuredTokens");
    if (!featuredExists) await redis.set("featuredTokens", []);
  } catch (error) {
    console.error("Error loading tokens:", error);
  }
}

async function updateTokenData(token) {
  try {
    const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`);
    const dexData = await dexResponse.json();
    const pair = dexData.pairs?.[0] || {};
    token.name = pair.baseToken?.name || token.name;
    token.marketCap = parseFloat(pair.fdv || 0);
    token.volume = parseFloat(pair.volume?.h24 || 0);
    token.hypeScore = calculateHypeScore(token);
    token.xMentions = generateXMentions(token); // Replace with X search later
    await redis.hset(`allTokens:${token.address}`, token);
    return token;
  } catch (error) {
    console.error(`Error updating token ${token.address}:`, error);
    return token;
  }
}

function calculateHypeScore(token) {
  let score = 60 + Math.floor(Math.random() * 15);
  const ageHours = parseInt(token.age);
  if (!isNaN(ageHours)) {
    if (ageHours < 3) score += 10;
    if (ageHours < 6) score += 5;
  }
  const marketCapMillions = token.marketCap / 1000000;
  if (marketCapMillions > 0.1) score += 5;
  if (marketCapMillions > 0.5) score += 5;
  if (token.volume > 5000) score += 5;
  if (token.volume > 20000) score += 5;
  return Math.min(score, 95);
}

function generateXMentions(token) {
  const baseMentions = 50 + Math.floor(Math.random() * 200);
  const marketCapMultiplier = token.marketCap ? Math.min(token.marketCap / 50000, 5) : 1;
  const volumeMultiplier = token.volume ? Math.min(token.volume / 5000, 5) : 1;
  return Math.floor(baseMentions * (marketCapMultiplier + volumeMultiplier) / 2);
}

function rankTokens(tokens) {
  return tokens.sort((a, b) => b.hypeScore - a.hypeScore);
}

// Polling every 5 minutes
setInterval(loadTokens, 5 * 60 * 1000);

// API Routes (unchanged: /api/new-tokens, /api/featured-tokens, /api/list-token, /api/search, /)

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  loadTokens(); // Initial load
});