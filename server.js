const express = require("express");
const axios = require("axios");
const fs = require("fs");
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("OK"));

const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "8orders_meta_verify_2024",
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1503757935199649904/goqYQiQnbPrEV4x4A8HRDwIdsO2361Cl3f2khuUTZ3G48j3pa9hFiUVz_irqlRZ4SHPc",
  PORT: process.env.PORT || 3000,
  POLL_INTERVAL_MS: 60 * 1000, // poll every 60 seconds
  UPSTASH_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
};

// Phrases Meta AI uses when handing off to a human (Arabic + English system messages)
const HANDOFF_KEYWORDS = [
  // English system messages (what the Graph API actually returns)
  "Your AI agent transferred this chat to you",
  "transferred this chat",
  "agent transferred",
  // Arabic phrases
  "سأقوم بتوصيلك",
  "بأحد ممثلي",
  "الدعم الفني",
  "خدمة العملاء",
  "سأحولك",
  "تحويلك",
];

// ─── Deduplication: Upstash Redis (persistent) with local Map fallback ────────
// Upstash is preferred — survives Render restarts/redeploys.
// Falls back to in-memory Map + /tmp file if Redis is not configured.

const USE_REDIS = !!(CONFIG.UPSTASH_URL && CONFIG.UPSTASH_TOKEN);
const notifiedConversations = new Map(); // local fallback only
const NOTIFIED_FILE = "/tmp/notified_conversations.json";

function loadLocalFallback() {
  if (USE_REDIS) return; // Redis handles persistence
  try {
    if (fs.existsSync(NOTIFIED_FILE)) {
      const data = JSON.parse(fs.readFileSync(NOTIFIED_FILE, "utf8"));
      for (const [id, ts] of Object.entries(data)) notifiedConversations.set(id, ts);
      console.log(`📂 Loaded ${notifiedConversations.size} notified conversations from disk`);
    }
  } catch (err) {
    console.log("ℹ Could not load notified file:", err.message);
  }
}

function saveLocalFallback() {
  try {
    fs.writeFileSync(NOTIFIED_FILE, JSON.stringify(Object.fromEntries(notifiedConversations)), "utf8");
  } catch (err) {
    console.log("ℹ Could not save notified file:", err.message);
  }
}

async function isNotified(convoId) {
  if (USE_REDIS) {
    try {
      const res = await axios.get(`${CONFIG.UPSTASH_URL}/get/notified:${convoId}`, {
        headers: { Authorization: `Bearer ${CONFIG.UPSTASH_TOKEN}` },
      });
      return res.data.result !== null;
    } catch (err) {
      console.log("⚠️ Redis GET failed, using local fallback:", err.message);
    }
  }
  return notifiedConversations.has(convoId);
}

async function markNotified(convoId) {
  if (USE_REDIS) {
    try {
      // 7200 seconds = 2 hours TTL
      await axios.post(
        `${CONFIG.UPSTASH_URL}/set/notified:${convoId}/1/ex/7200`,
        null,
        { headers: { Authorization: `Bearer ${CONFIG.UPSTASH_TOKEN}` } }
      );
      console.log(`💾 Redis: marked ${convoId} as notified (2h TTL)`);
      return;
    } catch (err) {
      console.log("⚠️ Redis SET failed, using local fallback:", err.message);
    }
  }
  notifiedConversations.set(convoId, Date.now());
  saveLocalFallback();
}

async function pruneLocalFallback() {
  if (USE_REDIS) return;
  const now = Date.now();
  let pruned = false;
  for (const [id, ts] of notifiedConversations) {
    if (now - ts > 2 * 60 * 60 * 1000) { notifiedConversations.delete(id); pruned = true; }
  }
  if (pruned) saveLocalFallback();
}

let PAGE_ID = null;

// ─── Webhook verification ────────────────────────────────────────────────────

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Webhook receiver (kept as fallback for standard handover events) ────────

app.post("/webhook", async (req, res) => {
  res.status(200).send("EVENT_RECEIVED");
  try {
    const body = req.body;
    console.log("📨 Webhook received:", JSON.stringify(body, null, 2));
    if (!body || body.object !== "page") return;
    for (const entry of body.entry || []) {
      const events = entry.messaging || entry.standby || [];
      for (const event of events) {
        console.log("📩 Event keys:", Object.keys(event).join(", "));

        // Standard Handover Protocol events
        if (event.pass_thread_control || event.take_thread_control) {
          const type = event.pass_thread_control ? "pass_thread_control" : "take_thread_control";
          console.log(`🚨 Handoff (${type})! Customer:`, event.sender?.id);
          await handleMetaAIHandoff(event.sender.id);
        }

        // Message echo from Meta AI (backup detection)
        if (event.message?.is_echo) {
          const text = event.message.text || "";
          const isHandoff = HANDOFF_KEYWORDS.some((kw) => text.includes(kw));
          if (isHandoff) {
            const customerId = event.recipient?.id;
            console.log("🚨 Handoff via echo! Customer:", customerId);
            await handleMetaAIHandoff(customerId);
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Unhandled webhook error:", err.message, err.stack);
  }
});

// ─── Polling: detect Meta AI handoffs via Graph API ──────────────────────────

async function initPageId() {
  try {
    const res = await axios.get("https://graph.facebook.com/v19.0/me", {
      params: { fields: "id,name", access_token: CONFIG.PAGE_ACCESS_TOKEN },
    });
    PAGE_ID = res.data.id;
    console.log(`📄 Page ready: ${res.data.name} (ID: ${PAGE_ID})`);
  } catch (err) {
    console.error("❌ Could not fetch page ID:", err.response?.data || err.message);
  }
}

async function pollForHandoffs() {
  if (!PAGE_ID) return;
  try {
    const res = await axios.get("https://graph.facebook.com/v19.0/me/conversations", {
      params: {
        fields: "id,messages.limit(10){message,from,created_time}",
        access_token: CONFIG.PAGE_ACCESS_TOKEN,
        limit: 25,
      },
    });

    const conversations = res.data?.data || [];
    const now = Date.now();

    await pruneLocalFallback();

    console.log(`🔄 Poll: checking ${conversations.length} conversations`);

    for (const convo of conversations) {
      // Messages arrive newest-first; reverse to get chronological order
      const messages = (convo.messages?.data || []).slice().reverse();
      if (messages.length === 0) continue;

      const latestMsg = messages[messages.length - 1];
      const latestMsgAge = now - new Date(latestMsg.created_time).getTime();

      // Only look at conversations active in the last 10 minutes
      if (latestMsgAge > 10 * 60 * 1000) continue;

      console.log(`  📬 Active convo ${convo.id} — ${messages.length} msgs, latest ${Math.round(latestMsgAge/1000)}s ago`);

      // Skip if we already notified for this conversation recently
      if (await isNotified(convo.id)) {
        console.log(`  ⏭ Already notified`);
        continue;
      }

      // Find the most recent message sent BY THE PAGE (Meta AI)
      const pageMessages = messages.filter((m) => m.from?.id === PAGE_ID);
      if (pageMessages.length === 0) {
        console.log(`  ℹ No page messages found`);
        continue;
      }
      const lastPageMsg = pageMessages[pageMessages.length - 1];
      console.log(`  📝 Last page msg (${Math.round((now - new Date(lastPageMsg.created_time).getTime())/1000)}s ago): "${lastPageMsg.message?.substring(0, 80)}"`);

      // Only care if that page message was recent (last 5 minutes)
      const lastPageMsgAge = now - new Date(lastPageMsg.created_time).getTime();
      if (lastPageMsgAge > 5 * 60 * 1000) {
        console.log(`  ⏰ Page msg too old`);
        continue;
      }

      // Check if it contains a handoff phrase
      const isHandoff = HANDOFF_KEYWORDS.some((kw) => lastPageMsg.message?.includes(kw));
      console.log(`  🔑 Handoff detected: ${isHandoff}`);
      if (!isHandoff) continue;

      // Find the customer (first sender who is not the page)
      const customerMsg = messages.find((m) => m.from?.id !== PAGE_ID);
      const customerId = customerMsg?.from?.id;
      if (!customerId) continue;

      console.log(`🔍 Poll detected handoff — customer: ${customerId}, convo: ${convo.id}`);
      // Pass the messages we already fetched so we don't need a second API call
      await handleMetaAIHandoff(customerId, convo.id, messages);
    }
  } catch (err) {
    console.error("❌ Poll error:", err.response?.data || err.message);
  }
}

// ─── Core logic ──────────────────────────────────────────────────────────────

async function handleMetaAIHandoff(customerId, convoId = null, cachedMessages = null) {
  try {
    const history = await getConversationHistory(customerId, convoId, cachedMessages);
    await sendDiscordNotification(customerId, history);
    // Only mark as notified AFTER Discord successfully received it
    if (convoId) await markNotified(convoId);
    console.log("✅ Discord notified for customer", customerId);
  } catch (err) {
    console.error("❌ Error:", err.message);
    // Do NOT mark as notified — allow retry on next poll
  }
}

async function getConversationHistory(customerId, convoId = null, cachedMessages = null) {
  // Fetch customer name (best effort — fall back gracefully)
  let profileName = `User ${customerId}`;
  try {
    const profileRes = await axios.get(`https://graph.facebook.com/v19.0/${customerId}`, {
      params: { fields: "name", access_token: CONFIG.PAGE_ACCESS_TOKEN },
    });
    profileName = profileRes.data?.name || profileName;
  } catch (err) {
    console.log(`ℹ Could not fetch profile name for ${customerId}`);
  }

  // Use cached messages from poll if available (avoids a second API call)
  if (cachedMessages && cachedMessages.length > 0) {
    return { profile: { name: profileName }, messages: cachedMessages };
  }

  // Fallback: fetch messages directly using conversation ID
  if (convoId) {
    try {
      const res = await axios.get(`https://graph.facebook.com/v19.0/${convoId}/messages`, {
        params: { fields: "message,from,created_time", limit: 15, access_token: CONFIG.PAGE_ACCESS_TOKEN },
      });
      const messages = (res.data?.data || []).reverse();
      return { profile: { name: profileName }, messages };
    } catch (err) {
      console.error("Error fetching convo by ID:", err.response?.data || err.message);
    }
  }

  // Last resort: fetch by user_id
  try {
    const convoRes = await axios.get(`https://graph.facebook.com/v19.0/me/conversations`, {
      params: { user_id: customerId, fields: "messages{message,from,created_time}", access_token: CONFIG.PAGE_ACCESS_TOKEN },
    });
    const messages = (convoRes.data?.data?.[0]?.messages?.data || []).reverse();
    return { profile: { name: profileName }, messages };
  } catch (err) {
    console.error("Error fetching convo by user_id:", err.response?.data || err.message);
  }

  return { profile: { name: profileName }, messages: [] };
}

async function sendDiscordNotification(customerId, { profile, messages }) {
  const customerName = profile?.name || `User ${customerId}`;
  const timestamp = new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" });
  const historyText = messages.slice(-15).map((msg) => {
    const isCustomer = msg.from?.id === customerId;
    const sender = isCustomer ? `👤 ${customerName}` : "🤖 Meta AI";
    const time = new Date(msg.created_time).toLocaleTimeString("ar-EG", { timeZone: "Africa/Cairo", timeStyle: "short" });
    return `**${sender}** *(${time})*\n${msg.message || "[media]"}`;
  }).join("\n\n");

  await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
    username: "8Orders AI Agent",
    embeds: [{
      title: "🚨 Customer needs human support",
      description: "Meta AI couldn't respond — manual intervention needed",
      color: 0xff4444,
      fields: [
        { name: "👤 Customer", value: customerName, inline: true },
        { name: "🆔 ID", value: `\`${customerId}\``, inline: true },
        { name: "🕐 Time", value: timestamp, inline: true },
        { name: "📝 Conversation", value: historyText || "No messages available" },
        { name: "🔗 Open Chat", value: `[Click here to reply](https://www.facebook.com/messages/t/${customerId})` },
      ],
      footer: { text: "8Orders Support System • Meta AI Handoff" },
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── Start ───────────────────────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
});

async function startPolling() {
  await pollForHandoffs();
  // Use setTimeout (not setInterval) so next poll only starts after current one finishes
  // This prevents concurrent polls from sending duplicate Discord notifications
  setTimeout(startPolling, CONFIG.POLL_INTERVAL_MS);
}

app.listen(CONFIG.PORT, "0.0.0.0", async () => {
  console.log(`🚀 8Orders webhook server running on port ${CONFIG.PORT}`);
  console.log(`💾 Storage: ${USE_REDIS ? "Upstash Redis (persistent)" : "local /tmp (ephemeral)"}`);
  loadLocalFallback();
  await initPageId();
  console.log(`🔍 Polling for Meta AI handoffs every ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
  startPolling();
});
