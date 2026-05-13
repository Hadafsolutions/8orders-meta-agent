const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("OK"));

const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "8orders_meta_verify_2024",
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1503757935199649904/goqYQiQnbPrEV4x4A8HRDwIdsO2361Cl3f2khuUTZ3G48j3pa9hFiUVz_irqlRZ4SHPc",
  PORT: process.env.PORT || 3000,
  POLL_INTERVAL_MS: 60 * 1000, // poll every 60 seconds
};

// Arabic phrases Meta AI uses when handing off to a human
const HANDOFF_KEYWORDS = [
  "سأقوم بتوصيلك",
  "بأحد ممثلي",
  "الدعم الفني",
  "خدمة العملاء",
  "سأحولك",
  "تحويلك",
];

// Track notified conversations to avoid duplicate Discord pings
// Map<conversationId, timestamp>
const notifiedConversations = new Map();

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

    // Remove stale entries (older than 2 hours) to allow re-notification
    for (const [id, ts] of notifiedConversations) {
      if (now - ts > 2 * 60 * 60 * 1000) notifiedConversations.delete(id);
    }

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
      if (notifiedConversations.has(convo.id)) {
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
      notifiedConversations.set(convo.id, now);
      await handleMetaAIHandoff(customerId);
    }
  } catch (err) {
    console.error("❌ Poll error:", err.response?.data || err.message);
  }
}

// ─── Core logic ──────────────────────────────────────────────────────────────

async function handleMetaAIHandoff(customerId) {
  try {
    const history = await getConversationHistory(customerId);
    await sendDiscordNotification(customerId, history);
    console.log("✅ Discord notified for customer", customerId);
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

async function getConversationHistory(customerId) {
  try {
    const profileRes = await axios.get(`https://graph.facebook.com/v19.0/${customerId}`, {
      params: { fields: "name", access_token: CONFIG.PAGE_ACCESS_TOKEN },
    });
    const convoRes = await axios.get(`https://graph.facebook.com/v19.0/me/conversations`, {
      params: { user_id: customerId, fields: "messages{message,from,created_time}", access_token: CONFIG.PAGE_ACCESS_TOKEN },
    });
    const messages = convoRes.data?.data?.[0]?.messages?.data || [];
    return { profile: profileRes.data, messages: messages.reverse() };
  } catch (err) {
    console.error("Error fetching conversation:", err.response?.data || err.message);
    return { profile: { name: `User ${customerId}` }, messages: [] };
  }
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

app.listen(CONFIG.PORT, "0.0.0.0", async () => {
  console.log(`🚀 8Orders webhook server running on port ${CONFIG.PORT}`);
  await initPageId();
  // Start polling immediately, then repeat every 60 seconds
  await pollForHandoffs();
  setInterval(pollForHandoffs, CONFIG.POLL_INTERVAL_MS);
  console.log(`🔍 Polling for Meta AI handoffs every ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
});
