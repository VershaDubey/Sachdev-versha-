const express = require("express");
const cors = require("cors");
require("dotenv").config();


const app = express();
app.use(cors());
app.use(express.json());

// Logging
app.use((req, res, next) => {
  console.log(`📩 [${req.method}] ${req.url}`);
  next();
});

// Health check
app.get("/ping", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is running fine ✅",
    time: new Date().toLocaleString(),
  });
});

// Config check - verify environment variables
app.get("/config", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Environment Configuration Status",
    environment_vars: {
      PORT: process.env.PORT ? "✅ Set" : "❌ Missing",
      SF_INSTANCE_URL: process.env.SF_INSTANCE_URL ? `✅ Set: ${process.env.SF_INSTANCE_URL}` : "❌ Missing",
      SF_ACCESS_TOKEN: process.env.SF_ACCESS_TOKEN ? "✅ Set" : "❌ Missing",
      SF_CLIENT_ID: process.env.SF_CLIENT_ID ? "✅ Set" : "❌ Missing",
      SF_CLIENT_SECRET: process.env.SF_CLIENT_SECRET ? "✅ Set" : "❌ Missing",
      WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN ? "✅ Set" : "❌ Missing",
      EMAIL_USER: process.env.EMAIL_USER ? "✅ Set" : "❌ Missing",
      RESEND_API_KEY: process.env.RESEND_API_KEY ? "✅ Set" : "❌ Missing",
    },
    current_time: new Date().toLocaleString(),
  });
});

// Routes
app.use("/mail", require("./routes/mail"));
app.use("/webhook", require("./routes/webhook"));

// Start server
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
