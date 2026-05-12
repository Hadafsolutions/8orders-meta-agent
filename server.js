const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

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
  const body = req.body;
  console.log("📨 Webhook received:", JSON.stringify(body, null, 2));
  if (body.object !== "page") return res.sendStatus(404);
  for (const entry of body.entry) {
    const events = entry.messaging || entry.standby || [];
    for (const event of events) {
      console.log("📩 Event keys:", Object.keys(event).join(", "));
      if (event.pass_thread_control) {
        console.log("🚨 Handoff detected! Customer:", event.sender?.id);
        await handleMetaAIHandoff(event);
      }
    }
  }
  res.status(200).send("EVENT_RECEIVED");
});

async function handleMetaAIHandoff(event) {
  const customerId = event.sender.id;
  try {
    const history = await getConversationHistory(customerId);
    await sendDiscordNotification(customerId, history, event);
    console.log(`✅ Discord notified for customer ${customerId}`);
  } catch (err) {
    console.error("❌ Error handling handoff:", err.message);
  }
}

async function getConversationHistory(customerId) {
  try {
    const profileRes = await axios.get(`https://graph.facebook.com/v19.0/${customerId}`, {
      params: { fields: "name,first_name,last_name", access_token: CONFIG.PAGE_ACCESS_TOKEN },
    });
    const profile = profileRes.data;
    const convoRes = await axios.get(`https://graph.facebook.com/v19.0/me/conversations`, {
      params: { user_id: customerId, fields: "messages{message,from,created_time}", access_token: CONFIG.PAGE_ACCESS_TOKEN },
    });
    const messages = convoRes.data?.data?.[0]?.messages?.data || [];
    return { profile, messages: messages.reverse() };
  } catch (err) {
    console.error("Error fetching conversation:", err.response?.data || err.message);
    return { profile: { name: `User ${customerId}` }, messages: [] };
  }
}

async function sendDiscordNotification(customerId, { profile, messages }, event) {
  const customerName = profile?.name || `User ${customerId}`;
  const timestamp = new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" });
  const historyText = messages.slice(-15).map((msg) => {
    const isCustomer = msg.from?.id === customerId;
    const sender = isCustomer ? `👤 ${customerName}` : "🤖 Meta AI";
    const time = new Date(msg.created_time).toLocaleTimeString("ar-EG", { timeZone: "Africa/Cairo", timeStyle: "short" });
    return `**${sender}** *(${time})*\n${msg.message || "[media/attachment]"}`;
  }).join("\n\n");

  await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
    username: "8Orders AI Agent",
    embeds: [{
      title: "🚨 عميل محتاج مساعدة بشرية",
      description: "Meta AI مش قادر يرد على العميل ده — محتاج تدخل يدوي",
      color: 0xff4444,
      fields: [
        { name: "👤 العميل", value: customerName, inline: true },
        { name: "🆔 Customer ID", value: `\`${customerId}\``, inline: true },
        { name: "🕐 الوقت", value: timestamp, inline: true },
        { name: "📝 سجل المحادثة", value: historyText || "مفيش رسائل متاحة" },
        { name: "🔗 افتح المحادثة", value: `[اضغط هنا للرد على العميل](https://www.facebook.com/messages/t/${customerId})` },
      ],
      footer: { text: "8Orders Support System • Meta AI Handoff" },
      timestamp: new Date().toISOString(),
    }],
  });
}

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 8Orders webhook server running on port ${CONFIG.PORT}`);
});