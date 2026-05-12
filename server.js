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
};

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
        if (event.pass_thread_control) {
          console.log("🚨 Handoff! Customer:", event.sender?.id);
          await handleMetaAIHandoff(event);
        }
      }
    }
  } catch (err) {
    console.error("❌ Unhandled webhook error:", err.message, err.stack);
  }
});

async function handleMetaAIHandoff(event) {
  const customerId = event.sender.id;
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

process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
});

app.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`🚀 8Orders webhook server running on port ${CONFIG.PORT}`);
});