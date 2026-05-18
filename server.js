const express = require("express");
const axios = require("axios");
const fs = require("fs");
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("OK"));

const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "8orders_meta_verify_2024",
  PAGE_ACCESS_TOKEN: process.env.PAGE_ACCESS_TOKEN,
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1503757935199649904/goqYQiQnbPrEV4x4A8HRDwIdsO2361Cl3f2khuUTZ3G48j3pa9hFiUVz_irqlRZ4SHPc",
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
const awaitingInfoMap = new Map();       // local fallback: customers we asked but haven't replied yet
const NOTIFIED_FILE = "/tmp/notified_conversations.json";
const AWAIT_TIMEOUT_MS = 10 * 60 * 1000; // wait up to 10 min for customer reply

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

// ─── Awaiting-info state: Redis + local Map ───────────────────────────────────
// Tracks customers we've asked for order/phone but haven't replied yet.
// Value = unix timestamp of when we asked (used to detect timeout + find reply).

async function getAwaiting(customerId) {
  if (USE_REDIS) {
    try {
      const res = await axios.get(`${CONFIG.UPSTASH_URL}/get/awaiting:${customerId}`, {
        headers: { Authorization: `Bearer ${CONFIG.UPSTASH_TOKEN}` },
      });
      return res.data.result !== null ? Number(res.data.result) : null;
    } catch (err) {
      console.log("⚠️ Redis GET awaiting failed:", err.message);
    }
  }
  return awaitingInfoMap.get(customerId) || null;
}

async function setAwaiting(customerId) {
  const ts = Date.now();
  if (USE_REDIS) {
    try {
      await axios.post(
        `${CONFIG.UPSTASH_URL}/set/awaiting:${customerId}/${ts}/ex/1800`,
        null,
        { headers: { Authorization: `Bearer ${CONFIG.UPSTASH_TOKEN}` } }
      );
      console.log(`⏳ Redis: awaiting info from ${customerId}`);
      return;
    } catch (err) {
      console.log("⚠️ Redis SET awaiting failed:", err.message);
    }
  }
  awaitingInfoMap.set(customerId, ts);
}

async function clearAwaiting(customerId) {
  if (USE_REDIS) {
    try {
      await axios.post(`${CONFIG.UPSTASH_URL}/del/awaiting:${customerId}`, null, {
        headers: { Authorization: `Bearer ${CONFIG.UPSTASH_TOKEN}` },
      });
      return;
    } catch (err) {
      console.log("⚠️ Redis DEL awaiting failed:", err.message);
    }
  }
  awaitingInfoMap.delete(customerId);
}

// ─── Unified handoff entry-point (used by both webhook + poll) ───────────────
// Starts the ask-first flow if not already in progress.
// The poll loop handles checking for the reply and notifying Discord.

async function initiateHandoffFlow(customerId) {
  if (await isNotified(customerId)) {
    console.log(`⏭ Already notified ${customerId} — skipping`);
    return;
  }
  const awaitedAt = await getAwaiting(customerId);
  if (awaitedAt) {
    console.log(`⏳ Already awaiting info from ${customerId} — poll will handle reply`);
    return;
  }
  console.log(`🔍 Initiating handoff flow for ${customerId} — asking for contact info`);
  await askForContactInfo(customerId);
  await setAwaiting(customerId);
}

// ─── Send contact-info request to customer via Messenger ─────────────────────

async function askForContactInfo(customerId) {
  const text =
    "شكراً لتواصلك معنا 🙏\n" +
    "لكي يتمكن فريقنا من مساعدتك بسرعة، يرجى مشاركة رقم طلبك أو رقم هاتفك.";
  await axios.post(
    "https://graph.facebook.com/v19.0/me/messages",
    { recipient: { id: customerId }, message: { text } },
    { params: { access_token: CONFIG.PAGE_ACCESS_TOKEN } }
  );
  console.log(`📤 Asked ${customerId} for order/phone number`);
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

// ─── Debug / test endpoints ──────────────────────────────────────────────────

app.get("/test-discord", async (_req, res) => {
  try {
    await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
      username: "8Orders AI Agent",
      embeds: [{
        title: "🧪 Test notification",
        description: "Manual test — server → Discord pipeline is working",
        color: 0x00cc44,
        fields: [
          { name: "📄 Page ID", value: PAGE_ID || "not loaded yet", inline: true },
          { name: "💾 Storage", value: USE_REDIS ? "Upstash Redis ✅" : "local /tmp ⚠️", inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
    res.status(200).send("✅ Test notification sent to Discord");
  } catch (err) {
    res.status(500).send(`❌ Failed: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
  }
});

app.get("/debug-poll", async (_req, res) => {
  if (!PAGE_ID) return res.status(500).send("❌ PAGE_ID not loaded — check PAGE_ACCESS_TOKEN");
  try {
    const result = await axios.get("https://graph.facebook.com/v19.0/me/conversations", {
      params: {
        fields: "id,messages.limit(30){message,from,created_time}",
        access_token: CONFIG.PAGE_ACCESS_TOKEN,
        limit: 10,
      },
    });
    const convos = result.data?.data || [];
    const now = Date.now();
    const report = convos.map(c => {
      const msgs = (c.messages?.data || []).slice().reverse();
      const latest = msgs[msgs.length - 1];
      const age = latest ? Math.round((now - new Date(latest.created_time).getTime()) / 1000) : null;
      const handoffMsg = msgs
        .find(m => HANDOFF_KEYWORDS.some(kw => m.message?.includes(kw)));
      return {
        id: c.id,
        msgs: msgs.length,
        latestAge: `${age}s`,
        handoff: !!handoffMsg,
        handoffFrom: handoffMsg?.from?.id || (handoffMsg ? "system" : null),
        handoffMsg: handoffMsg?.message?.substring(0, 60) || null,
      };
    });
    res.json({ pageId: PAGE_ID, conversations: report });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

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
          await initiateHandoffFlow(event.sender.id);
        }

        // Message echo from Meta AI (backup detection)
        if (event.message?.is_echo) {
          const text = event.message.text || "";
          const isHandoff = HANDOFF_KEYWORDS.some((kw) => text.includes(kw));
          if (isHandoff) {
            const customerId = event.recipient?.id;
            console.log("🚨 Handoff via echo! Customer:", customerId);
            await initiateHandoffFlow(customerId);
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
        fields: "id,messages.limit(30){message,from,created_time}",
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

      // Skip if we already notified for this customer recently (keyed by customerId,
      // not convoId, so webhook-triggered notifications also prevent poll re-fires)
      const customerMsg = messages.find((m) => m.from?.id !== PAGE_ID);
      const customerId = customerMsg?.from?.id;
      if (!customerId) continue;

      if (await isNotified(customerId)) {
        console.log(`  ⏭ Already notified`);
        continue;
      }

      // Scan ALL fetched messages for handoff keywords — no time-limit on the
      // handoff message itself because:
      //   1. API lag can cause the first poll to miss it, making the next poll see
      //      it as >5 min old and skip it (intermittent miss bug)
      //   2. Customer follow-up messages can push the handoff beyond a small limit
      // The 2h dedup (isNotified/markNotified) prevents duplicate notifications.
      const handoffMsg = messages
        .find((m) => HANDOFF_KEYWORDS.some((kw) => m.message?.includes(kw)));

      if (!handoffMsg) {
        console.log(`  ℹ No handoff message found`);
        continue;
      }
      console.log(`  🔑 Handoff detected: "${handoffMsg.message?.substring(0, 80)}" (from: ${handoffMsg.from?.id || "system"})`);

      // ── Ask-first flow ────────────────────────────────────────────────────
      // Primary: find our own question message in the conversation.
      // This is more reliable than Redis timestamps — works even if Redis TTL
      // expired or the first poll had a lag. Redis is used only as a short lock
      // to prevent duplicate asks between poll cycles.
      const ourQuestion = messages.find(
        (m) => m.from?.id !== customerId &&
               m.message?.includes("شكراً لتواصلك معنا 🙏")
      );

      if (ourQuestion) {
        // Our question is in the conversation — use its timestamp as the anchor
        const questionTime = new Date(ourQuestion.created_time).getTime();
        const customerReplies = messages.filter(
          (m) => m.from?.id === customerId &&
                 new Date(m.created_time).getTime() > questionTime
        );

        if (customerReplies.length > 0) {
          const contactInfo = customerReplies.map((m) => m.message).filter(Boolean).join(" | ");
          console.log(`📋 Customer provided info: "${contactInfo}"`);
          await clearAwaiting(customerId);
          await handleMetaAIHandoff(customerId, convo.id, messages, contactInfo);
        } else if (now - questionTime > AWAIT_TIMEOUT_MS) {
          console.log(`⏰ No reply from ${customerId} after 10 min — notifying without contact info`);
          await clearAwaiting(customerId);
          await handleMetaAIHandoff(customerId, convo.id, messages, null);
        } else {
          console.log(`  ⏳ Waiting for reply (${Math.round((now - questionTime) / 1000)}s elapsed)`);
        }
      } else {
        // Our question not in fetched window — fall back to Redis for state
        const awaitedAt = await getAwaiting(customerId);
        if (awaitedAt && now - awaitedAt > AWAIT_TIMEOUT_MS) {
          // Redis says we asked >10 min ago but question is out of range — send without info
          console.log(`⏰ Timeout (question outside fetch window) — notifying without contact info`);
          await clearAwaiting(customerId);
          await handleMetaAIHandoff(customerId, convo.id, messages, null);
        } else if (!awaitedAt) {
          // Never asked — ask now
          await initiateHandoffFlow(customerId);
        } else {
          console.log(`  ⏳ Waiting (question outside fetch window, ${Math.round((now - awaitedAt) / 1000)}s elapsed)`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Poll error:", err.response?.data || err.message);
  }
}

// ─── Core logic ──────────────────────────────────────────────────────────────

async function handleMetaAIHandoff(customerId, convoId = null, cachedMessages = null, contactInfo = null) {
  try {
    const history = await getConversationHistory(customerId, convoId, cachedMessages);
    await sendDiscordNotification(customerId, history, contactInfo);
    // Mark by customerId so both poll and webhook paths share the same dedup key
    await markNotified(customerId);
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

async function sendDiscordNotification(customerId, { profile, messages }, contactInfo = null) {
  const customerName = profile?.name || `User ${customerId}`;
  const timestamp = new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" });
  const historyText = messages.slice(-15).map((msg) => {
    const isCustomer = msg.from?.id === customerId;
    const sender = isCustomer ? `👤 ${customerName}` : "🤖 Meta AI";
    const time = new Date(msg.created_time).toLocaleTimeString("ar-EG", { timeZone: "Africa/Cairo", timeStyle: "short" });
    return `**${sender}** *(${time})*\n${msg.message || "[media]"}`;
  }).join("\n\n");

  const fields = [
    { name: "👤 Customer", value: customerName, inline: true },
    { name: "🆔 ID", value: `\`${customerId}\``, inline: true },
    { name: "🕐 Time", value: timestamp, inline: true },
    {
      name: contactInfo ? "📋 Order / Phone" : "📋 Order / Phone",
      value: contactInfo || "❌ No reply provided",
      inline: false,
    },
    { name: "📝 Conversation", value: historyText || "No messages available" },
    { name: "🔗 Open Chat", value: `[Click here to reply](https://www.facebook.com/messages/t/${customerId})` },
  ];

  await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
    username: "8Orders AI Agent",
    embeds: [{
      title: "🚨 Customer needs human support",
      description: "Meta AI couldn't respond — manual intervention needed",
      color: contactInfo ? 0xff8800 : 0xff4444, // orange if info provided, red if not
      fields,
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
