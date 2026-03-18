const express = require("express");
const router = express.Router();
const axios = require("axios");
const sendMail = require("../utils/sendMail");
const spokenToEmail = require("../utils/spokenToEmail");
const https = require("https");
const agent = new https.Agent({ rejectUnauthorized: false });

// ✅ Always fetch a fresh token using password grant
const getSalesforceToken = async () => {
  try {
    const response = await axios.post(
      "https://login.salesforce.com/services/oauth2/token",
      new URLSearchParams({
        grant_type: "password",
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        username: process.env.SF_USERNAME,
        password: process.env.SF_PASSWORD,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );
    process.env.SF_ACCESS_TOKEN = response.data.access_token;
    console.log("✅ Salesforce token fetched successfully");
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Failed to get Salesforce token:", error.response?.data || error.message);
    throw error;
  }
};

router.post("/", async (req, res) => {
  try {
    console.log("📦 Webhook received payload:", JSON.stringify(req.body, null, 2));

    // ✅ Get fresh SF token first (comment this out if Render blocks login.salesforce.com)
    // await getSalesforceToken();

    const extracted = req.body.extracted_data;
    const telephoneData = req.body.telephony_data;
    const transcriptedData = req.body.transcript;
    let conversationDueration = req.body.conversation_duration;

    function formatDuration(seconds) {
      const totalMilliseconds = Math.floor(seconds * 1000);
      const minutes = Math.floor(totalMilliseconds / 60000);
      const remainingAfterMinutes = totalMilliseconds % 60000;
      const secs = Math.floor(remainingAfterMinutes / 1000);
      const milliseconds = remainingAfterMinutes % 1000;

      let result = "";
      if (minutes > 0) result += `${minutes} min `;
      if (secs > 0) result += `${secs} sec `;
      if (milliseconds > 0) result += `${milliseconds} ms`;
      return result.trim() || "0 sec";
    }

    function formatDateTime(date) {
      const year = date.getFullYear();
      const month = (date.getMonth() + 1).toString().padStart(2, "0");
      const day = date.getDate().toString().padStart(2, "0");
      const hours = date.getHours().toString().padStart(2, "0");
      const minutes = date.getMinutes().toString().padStart(2, "0");
      return `${year}-${month}-${day} ${hours}:${minutes}:00`;
    }

    const now = new Date();
    const schedStartTime = formatDateTime(now);
    const end = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const schedEndTime = formatDateTime(end);

    conversationDueration = formatDuration(conversationDueration);

    if (!extracted) {
      return res.status(400).json({ error: "No extracted_data found in payload" });
    }

    // ✅ FIXED: Support both camelCase (Bolna) and lowercase variable names
    let {
      user_name,
      mobile,
      pincode,
      service_appointment_date,
      issuedesc,
      issueDesc,       // Bolna sends this
      fulladdress,
      fullAddress,     // Bolna sends this
      registration_number,
    } = extracted;

    // ✅ Use whichever version is present, with safe fallbacks for WhatsApp (no empty strings)
    const issueDescFinal        = issuedesc    || issueDesc    || "Service Request";
    const fullAddressFinal      = fulladdress  || fullAddress  || "Address not provided";
    const userNameFinal         = user_name                    || "Customer";
    const registrationFinal     = registration_number          || "N/A";
    const pincodeFinal          = pincode                      || "N/A";

    let recordingURL = telephoneData?.recording_url || " ";
    const technician_visit_date = service_appointment_date || new Date().toISOString();
    let predDate = new Date(technician_visit_date).toLocaleString();

    const dateObj = new Date(technician_visit_date);
    const preferred_date = dateObj.toISOString().split("T")[0];

    let hours = dateObj.getHours();
    let minutes = dateObj.getMinutes().toString().padStart(2, "0");
    const ampm = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const preferred_time = `${hours}:${minutes} ${ampm}`;

    // Classify case type
    const classifyIssueType = (desc) => {
      if (!desc) return "Service Appointment";
      const serviceKeywords = ["not working", "leak", "water leaking", "kharab", "repair", "ac not working", "washing machine not working", "issue", "problem", "battery", "faulty"];
      const complaintKeywords = ["complaint", "rude", "delay", "wrong", "poor", "service complaint", "technician complaint"];
      const lowerDesc = desc.toLowerCase();
      if (complaintKeywords.some((word) => lowerDesc.includes(word))) return "Complaint";
      if (serviceKeywords.some((word) => lowerDesc.includes(word))) return "Service Appointment";
      return "Service Appointment";
    };

    const caseType = classifyIssueType(issueDescFinal);
    console.log("🧠 Case Type:", caseType);

    // Validate SF_INSTANCE_URL
    const rawSfInstanceUrl = (process.env.SF_INSTANCE_URL || "").trim();
    if (!rawSfInstanceUrl) {
      return res.status(500).json({
        success: false,
        error: "SF_INSTANCE_URL missing or empty",
        details: { message: "Set SF_INSTANCE_URL in Render env vars" },
      });
    }

    let sfURL;
    try {
      const normalizedBase = rawSfInstanceUrl.replace(/\/+$/, "");
      sfURL = new URL("/services/apexrest/caseService", normalizedBase).toString();
    } catch (e) {
      return res.status(500).json({
        success: false,
        error: "Invalid Salesforce instance URL",
        details: { message: e.message },
      });
    }

    console.log("🔗 Final Salesforce URL:", sfURL);

    const casePayload = {
      operation: "insert",
      subject: caseType,
      description: issueDescFinal,
      origin: "Phone",
      priority: "Medium",

      accountId: "",
      contactId: "",

      user_name: userNameFinal,
      email: " ",
      mobile: mobile,
      pincode: pincodeFinal,

      preferred_date: preferred_date,
      preferred_time: preferred_time,

      issuedesc: issueDescFinal,
      fulladdress: fullAddressFinal,

      transcript: transcriptedData,
      recording_link: recordingURL,
      sentiment: "Neutral",
      conversationDueration: conversationDueration,

      workTypeId: "",
      assetId: "",

      schedStartTime: schedStartTime,
      schedEndTime: schedEndTime,
    };

    console.log("📤 Salesforce Request Payload:", JSON.stringify(casePayload, null, 2));

    const sfResponse = await axios.post(sfURL, casePayload, {
      headers: {
        Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      httpsAgent: agent,
    });

    console.log("✅ Salesforce Case created:", sfResponse.data);

    const caseId = "SR-" + sfResponse.data.caseNumber;
    const email = sfResponse.data.email || " ";
    const serviceTime = new Date(technician_visit_date).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    // Step 2: Send email
    const emailHTML = `
  <h2 style="color: #004d40;">Greaves Electric Mobility – Service Update</h2>
  <p>Dear ${userNameFinal},</p>
  <p>We have received your request regarding <b>${issueDescFinal}</b>.</p>
  <p><b>Case ID:</b> ${caseId}<br/></p>
  <p>
    <b>Registered Address:</b><br/>
    ${fullAddressFinal}<br/>
    <b>Service Time:</b> ${serviceTime}
  </p>
  <p>
    <b>Registered Phone:</b> ${mobile}<br/>
    <b>Registered Email:</b> ${email}
  </p>
  <p style="margin-top: 30px;">Regards,<br/><b>Greaves Electric Mobility Support Team</b></p>
`;

    await sendMail({
      to: email,
      subject: `Greaves Electric Mobility – Service Update — Case ${caseId}`,
      html: emailHTML,
    });

    // Step 3: Send WhatsApp — ✅ All parameters guaranteed non-empty
    const parameters = [
      userNameFinal,
      predDate,
      fullAddressFinal,
      registrationFinal,
      issueDescFinal,
    ];

    console.log("📱 WhatsApp parameters:", parameters);

    const whatsappMobile = mobile.replace(/^(\+91|91)/, "");
    const whatsappPayload = {
      messaging_product: "whatsapp",
      to: "91" + whatsappMobile,
      type: "template",
      template: {
        name: "greaves_service_demo",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: parameters.map((text) => ({ type: "text", text: String(text) })),
          },
        ],
      },
    };

    const whatsappResponse = await axios.post(
      "https://graph.facebook.com/v22.0/475003915704924/messages",
      whatsappPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "identity",
        },
      }
    );

    console.log("✅ WhatsApp message sent:", whatsappResponse.data);

    res.status(200).json({
      success: true,
      message: "Salesforce Case created, and WhatsApp message delivered",
      caseId: caseId,
      salesforceResponse: sfResponse.data,
      whatsappResponse: whatsappResponse.data,
      schedStartTime: schedStartTime,
      schedEndTime: schedEndTime,
    });

  } catch (error) {
    console.error("❌ Webhook error:", {
      message: error.message,
      code: error.code,
      statusCode: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message || "Internal Server Error",
      details: {
        message: error.message,
        code: error.code,
      },
    });
  }
});

module.exports = router;