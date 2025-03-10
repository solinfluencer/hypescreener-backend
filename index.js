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
    // Fallback to DexScreener if Solscan fails
    try {
      console.log("Falling back to DexScreener...");
      const response = await fetch("https://api.dexscreener.com/latest/dex/search?q=solana");
      if (!response.ok) throw new Error(`DexScreener API error: ${response.status}`);
      const data = await response.json();
      
      const now = Date.now();
      const twelveHoursAgo = now - (12 * 60 * 60 * 1000);
      
      const newTokens = data.pairs
        .filter(pair => {
          try {
            return pair.chainId === "solana" && pair.pairCreatedAt > twelveHoursAgo;
          } catch (e) {
            return false;
          }
        })
        .map(pair => ({
          name: pair.baseToken?.name || pair.baseToken?.symbol || "Unknown",
          symbol: pair.baseToken?.symbol || "",
          address: pair.baseToken?.address || "",
          age: Math.floor((now - pair.pairCreatedAt) / 3600000) + "h",
          marketCap: parseFloat(pair.fdv || 0),
          volume: parseFloat(pair.volume?.h24 || 0),
          liquidity: parseFloat(pair.liquidity?.usd || 0),
          price: parseFloat(pair.priceUsd || 0),
          priceChange: parseFloat(pair.priceChange?.h24 || 0),
          holders: Math.floor(Math.random() * 300) + 50,
          hypeScore: 0,
          xMentions: 0,
        }))
        .filter(token => token.name !== "Unknown" && token.address);
      
      console.log(`Found ${newTokens.length} new tokens from DexScreener`);
      
      // Calculate hype scores and X mentions
      newTokens.forEach(token => {
        token.hypeScore = calculateHypeScore(token);
        token.xMentions = generateXMentions(token);
        token.chartData = generateChartData(token);
      });
      
      // Store in Redis
      await redis.set("newTokens", rankTokens(newTokens).slice(0, 5));
    } catch (dexError) {
      console.error("Error falling back to DexScreener:", dexError);
    }
  }
}

async function updateTokenData(token) {
  try {
    const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`);
    const dexData = await dexResponse.json();
    const pair = dexData.pairs?.[0] || {};
    
    token.name = pair.baseToken?.name || token.name;
    token.symbol = pair.baseToken?.symbol || "";
    token.marketCap = parseFloat(pair.fdv || 0);
    token.volume = parseFloat(pair.volume?.h24 || 0);
    token.liquidity = parseFloat(pair.liquidity?.usd || 0);
    token.price = parseFloat(pair.priceUsd || 0);
    token.priceChange = parseFloat(pair.priceChange?.h24 || 0);
    token.holders = Math.floor(Math.random() * 300) + 50; // Mock data
    token.hypeScore = calculateHypeScore(token);
    token.xMentions = generateXMentions(token);
    token.chartData = generateChartData(token);
    
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
  // Boost based on price change if positive
  if (token.priceChange > 10) score += 5;
  if (token.priceChange > 50) score += 5;
  return Math.min(score, 95);
}

function generateXMentions(token) {
  const baseMentions = 50 + Math.floor(Math.random() * 200);
  const marketCapMultiplier = token.marketCap ? Math.min(token.marketCap / 50000, 5) : 1;
  const volumeMultiplier = token.volume ? Math.min(token.volume / 5000, 5) : 1;
  return Math.floor(baseMentions * (marketCapMultiplier + volumeMultiplier) / 2);
}

function generateChartData(token) {
  const priceChange = token.priceChange || 0;
  const isPositive = priceChange >= 0;
  const data = [];
  const points = 11;

  if (isPositive) {
    // Upward trend with some variation
    for (let i = 0; i < points; i++) {
      const progress = i / (points - 1);
      const randomVariation = Math.random() * 0.3 - 0.1; // -10% to +20% variation
      data.push(10 + progress * priceChange * 0.5 + randomVariation * progress * priceChange);
    }
  } else {
    // Downward trend with some variation
    for (let i = 0; i < points; i++) {
      const progress = i / (points - 1);
      const randomVariation = Math.random() * 0.3 - 0.1; // -10% to +20% variation
      data.push(30 - progress * Math.abs(priceChange) * 0.5 + randomVariation * progress * Math.abs(priceChange));
    }
  }

  return data;
}

function rankTokens(tokens) {
  return tokens.sort((a, b) => b.hypeScore - a.hypeScore);
}

// API Routes
app.get("/api/new-tokens", async (req, res) => {
  try {
    let newTokens = await redis.get("newTokens");
    
    // If no tokens in Redis or force refresh requested, fetch new ones
    if (!newTokens || newTokens.length === 0 || req.query.refresh === 'true') {
      await loadTokens();
      newTokens = await redis.get("newTokens");
    }
    
    res.json(newTokens || []);
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

    // Create token object
    const token = {
      name,
      address,
      age: "N/A",
      marketCap: 0,
      volume: 0,
      hypeScore: 0,
      xMentions: 0,
      sponsored: true,
    };

    // Update token with trading data
    await updateTokenData(token);

    // Get current featured tokens
    let featuredTokens = await redis.get("featuredTokens") || [];

    // Add new token
    featuredTokens.unshift(token);

    // Limit to top 5
    featuredTokens = featuredTokens.slice(0, 5);

    // Update Redis
    await redis.set("featuredTokens", featuredTokens);

    // Trigger Pusher event
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

    // Check if token exists in Redis
    const token = await redis.hgetall(`allTokens:${q}`);

    if (token && token.address) {
      return res.json(token);
    }

    // If not in Redis, try to fetch from Solscan
    const solscanResponse = await fetch(`https://api.solscan.io/v2/token/meta?token=${q}`);
    
    if (solscanResponse.ok) {
      const solscanData = await solscanResponse.json();
      
      if (solscanData && solscanData.success) {
        // Now get trading data from DexScreener
        const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${q}`);
        const dexData = await dexResponse.json();
        const pair = dexData.pairs?.[0];
        
        const token = {
          name: solscanData.data?.name || solscanData.data?.symbol || "Unknown",
          symbol: solscanData.data?.symbol || "",
          address: q,
          age: "N/A",
          marketCap: pair ? parseFloat(pair.fdv || 0) : 0,
          volume: pair ? parseFloat(pair.volume?.h24 || 0) : 0,
          price: pair ? parseFloat(pair.priceUsd || 0) : 0,
          priceChange: pair ? parseFloat(pair.priceChange?.h24 || 0) : 0,
          hypeScore: 70, // Default hype score
          xMentions: 500, // Default X mentions
          chartData: generateChartData({
            priceChange: pair ? parseFloat(pair.priceChange?.h24 || 0) : 0
          }),
        };

        // Store in Redis for future queries
        await redis.hset(`allTokens:${token.address}`, token);

        return res.json(token);
      }
    }

    // If Solscan fails, fallback to DexScreener only
    const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${q}`);
    const dexData = await dexResponse.json();
    const pair = dexData.pairs?.[0];
    
    if (pair) {
      const token = {
        name: pair.baseToken?.name || "Unknown",
        symbol: pair.baseToken?.symbol || "",
        address: pair.baseToken?.address || q,
        age: "N/A",
        marketCap: parseFloat(pair.fdv || 0),
        volume: parseFloat(pair.volume?.h24 || 0),
        price: parseFloat(pair.priceUsd || 0),
        priceChange: parseFloat(pair.priceChange?.h24 || 0),
        hypeScore: calculateHypeScore({
          marketCap: parseFloat(pair.fdv || 0),
          volume: parseFloat(pair.volume?.h24 || 0),
          age: "N/A"
        }),
        xMentions: generateXMentions({
          marketCap: parseFloat(pair.fdv || 0),
          volume: parseFloat(pair.volume?.h24 || 0)
        }),
        chartData: generateChartData({
          priceChange: parseFloat(pair.priceChange?.h24 || 0)
        }),
      };

      // Store in Redis for future queries
      await redis.hset(`allTokens:${token.address}`, token);

      return res.json(token);
    }

    // If not found anywhere
    res.json({
      name: "Not Found",
      address: q,
      age: "N/A",
      marketCap: 0,
      volume: 0,
      hypeScore: 0,
      xMentions: 0,
    });
  } catch (error) {
    console.error("Error searching token:", error);
    res.status(500).json({ error: "Failed to search token" });
  }
});

// Add a simple health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "HypeScreener API is running" });
});

// Polling every 5 minutes
setInterval(loadTokens, 5 * 60 * 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  loadTokens(); // Initial load
});