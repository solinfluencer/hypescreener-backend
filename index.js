const express = require("express");
const WebSocket = require("ws");
const fetch = require("node-fetch");
const Pusher = require("pusher");
const { Redis } = require("@upstash/redis");
const cors = require("cors");
const app = express();

// Enable CORS for your frontend
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000"
}));
app.use(express.json());

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});

// Initialize Redis
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function loadInitialTokens() {
  try {
    console.log("Loading initial tokens from Helius...");
    const response = await fetch(`https://api.helius.xyz/v0/tokens?api-key=${process.env.HELIUS_API_KEY}`);
    if (!response.ok) throw new Error(`Helius API error: ${response.status}`);
    const tokens = await response.json();
    
    const newTokens = tokens
      .filter(t => {
        try {
          return (Date.now() - new Date(t.createdAt).getTime()) < 12 * 3600 * 1000;
        } catch (e) {
          return false;
        }
      })
      .map(t => ({
        name: t.name || "Unknown",
        address: t.mint,
        age: Math.floor((Date.now() - new Date(t.createdAt).getTime()) / 3600000) + "h",
        marketCap: 0,
        volume: 0,
        hypeScore: 0,
        xMentions: 0
      }));
    
    console.log(`Found ${newTokens.length} new tokens`);
    
    await Promise.all(newTokens.map(updateTokenData));
    
    await redis.set("newTokens", rankTokens(newTokens).slice(0, 5));
    
    const featuredExists = await redis.exists("featuredTokens");
    if (!featuredExists) {
      await redis.set("featuredTokens", []);
    }
  } catch (error) {
    console.error("Error loading initial tokens:", error);
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
    token.xMentions = generateXMentions(token);
    
    await redis.hset(`allTokens:${token.address}`, token);
    
    return token;
  } catch (error) {
    console.error(`Error updating token data for ${token.address}:`, error);
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

// Connect to Helius WebSocket
const connectToHelius = () => {
  console.log("Connecting to Helius WebSocket...");
  
  const ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
  
  ws.on("open", () => {
    console.log("Connected to Helius WebSocket");
    ws.send(JSON.stringify({
      command: "subscribe",
      accounts: [],
      types: ["TOKEN_MINT"]
    }));
  });
  
  ws.on("message", async (data) => {
    try {
      const event = JSON.parse(data);
      if (event.type !== "TOKEN_MINT") return;
      
      const mint = event.data;
      const ageMs = Date.now() - new Date(mint.timestamp).getTime();
      if (ageMs >= 12 * 3600 * 1000) return;
      
      console.log(`New token mint detected: ${mint.name || mint.mint}`);
      
      const token = {
        name: mint.name || "Unknown",
        address: mint.mint,
        age: Math.floor(ageMs / 3600000) + "h",
        marketCap: 0,
        volume: 0,
        hypeScore: 0,
        xMentions: 0
      };
      
      const exists = await redis.hexists(`allTokens:${token.address}`, "address");
      if (exists) return;
      
      await updateTokenData(token);
      
      let newTokens = await redis.get("newTokens") || [];
      newTokens.unshift(token);
      newTokens = rankTokens(newTokens).slice(0, 5);
      await redis.set("newTokens", newTokens);
      pusher.trigger("new-tokens-channel", "new-token-event", token);
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
    }
  });
  
  ws.on("error", (error) => {
    console.error("Helius WebSocket error:", error);
    setTimeout(connectToHelius, 5000);
  });
  
  ws.on("close", () => {
    console.log("Helius WebSocket connection closed");
    setTimeout(connectToHelius, 5000);
  });
};

// API Routes
app.get("/api/new-tokens", async (req, res) => {
  try {
    const newTokens = await redis.get("newTokens") || [];
    res.json(newTokens);
  } catch (error) {
    console.error("Error fetching new tokens:", error);
    res.status(500).json({ error: "Failed to fetch new tokens" });
  }
});

app.get("/api/featured-tokens", async (req, res) => {
  try {
    const featuredTokens = await redis.get("featuredTokens") || [];
    res.json(featuredTokens);
  } catch (error) {
    console.error("Error fetching featured tokens:", error);
    res.status(500).json({ error: "Failed to fetch featured tokens" });
  }
});

app.post("/api/list-token", async (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name || !address) {
      return res.status(400).json({ error: "Name and address are required" });
    }
    
    const token = {
      name,
      address,
      age: "N/A",
      marketCap: 0,
      volume: 0,
      hypeScore: 0,
      xMentions: 0,
      sponsored: true
    };
    
    await updateTokenData(token);
    
    let featuredTokens = await redis.get("featuredTokens") || [];
    featuredTokens.unshift(token);
    featuredTokens = featuredTokens.slice(0, 5);
    await redis.set("featuredTokens", featuredTokens);
    pusher.trigger("featured-tokens-channel", "new-featured-event", token);
    
    res.json({ success: true });
  } catch (error) {
    console.error("Error listing token:", error);
    res.status(500).json({ error: "Failed to list token" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: "Query parameter 'q' is required" });
    }
    
    const token = await redis.hgetall(`allTokens:${q}`);
    if (token && token.address) {
      return res.json(token);
    }
    
    const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${q}`);
    const dexData = await dexResponse.json();
    const pair = dexData.pairs?.[0];
    
    if (pair) {
      const token = {
        name: pair.baseToken?.name || "Unknown",
        address: pair.baseToken?.address || q,
        age: "N/A",
        marketCap: parseFloat(pair.fdv || 0),
        volume: parseFloat(pair.volume?.h24 || 0),
        hypeScore: 70,
        xMentions: 500
      };
      await redis.hset(`allTokens:${token.address}`, token);
      return res.json(token);
    }
    
    res.json({
      name: "Not Found",
      address: q,
      age: "N/A",
      marketCap: 0,
      volume: 0,
      hypeScore: 0,
      xMentions: 0
    });
  } catch (error) {
    console.error("Error searching token:", error);
    res.status(500).json({ error: "Failed to search token" });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "HypeScreener API is running" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  loadInitialTokens();
  connectToHelius();
});