const express = require("express");
const router = express.Router();
const axios = require("axios");
const sendMail = require("../utils/sendMail");
const spokenToEmail = require("../utils/spokenToEmail");
const https = require("https");
const agent = new https.Agent({ rejectUnauthorized: false });

// Function to refresh Salesforce access token
const refreshSalesforceToken = async () => {
  try {
    const response = await axios.post(
      `${process.env.SF_INSTANCE_URL}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: process.env.SF_CLIENT_ID,
        client_secret: process.env.SF_CLIENT_SECRET,
        refresh_token: process.env.SF_REFRESH_TOKEN,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    process.env.SF_ACCESS_TOKEN = response.data.access_token;
    console.log("🔄 Salesforce token refreshed successfully");
  } catch (error) {
    console.error("❌ Failed to refresh Salesforce token:", error.response?.data || error.message);
    throw error;
  }
};

router.post("/", async (req, res) => {
  try {
    console.log("📦 Webhook received payload:", JSON.stringify(req.body, null, 2));

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

// current time
const now = new Date();
const schedStartTime = formatDateTime(now);

// add 6 hours
const end = new Date(now.getTime() + 6 * 60 * 60 * 1000);
const schedEndTime = formatDateTime(end);

    conversationDueration = formatDuration(conversationDueration);

    if (!extracted) {
      return res.status(400).json({ error: "No extracted_data found in payload" });
    }

    let { user_name, mobile, pincode, service_appointment_date, issuedesc, fulladdress,registration_number } = extracted;
    let recordingURL = telephoneData?.recording_url || ' ';
    const technician_visit_date = service_appointment_date || new Date().toISOString();
    let issueDesc = issuedesc;
    let fullAddress = fulladdress;
    let predDate = new Date(technician_visit_date).toLocaleString();

    const dateObj = new Date(technician_visit_date);

// YYYY-MM-DD
const preferred_date = dateObj.toISOString().split("T")[0];

// hh:mm AM/PM
let hours = dateObj.getHours();
let minutes = dateObj.getMinutes().toString().padStart(2, "0");
const ampm = hours >= 12 ? "PM" : "AM";
hours = hours % 12 || 12;

const preferred_time = `${hours}:${minutes} ${ampm}`;
    //step 0 to classify the subject of salesforce case
    const classifyIssueType = (desc) => {
      if (!desc) return "Service Appointment";

      const serviceKeywords = [
        "not working",
        "leak",
        "water leaking",
        "kharab",
        "repair",
        "ac not working",
        "washing machine not working",
        "issue",
        "problem",
      ];

      const complaintKeywords = [
        "complaint",
        "rude",
        "delay",
        "wrong",
        "poor",
        "service complaint",
        "technician complaint",
      ];

      const lowerDesc = desc.toLowerCase();

      // Match complaint first (more specific)
      if (complaintKeywords.some((word) => lowerDesc.includes(word))) {
        return "Complaint";
      }

      // Match service-related words
      if (serviceKeywords.some((word) => lowerDesc.includes(word))) {
        return "Service Appointment";
      }

      // Default
      return "Service Appointment";
    };

    const caseType = classifyIssueType(issueDesc);
    console.log("🧠 Case Type:", caseType);

    //Step 1 to Create Case in Salesforce
    // Validate environment variables
    if (!process.env.SF_INSTANCE_URL) {
      console.error("❌ SF_INSTANCE_URL not set in environment variables");
      return res.status(500).json({
        success: false,
        error: "Salesforce instance URL not configured",
        details: {
          message: "SF_INSTANCE_URL environment variable is missing. Please configure it on Render dashboard.",
          required_env_vars: ["SF_INSTANCE_URL", "SF_ACCESS_TOKEN"]
        }
      });
    }

    if (!process.env.SF_ACCESS_TOKEN) {
      console.error("❌ SF_ACCESS_TOKEN not set in environment variables");
      return res.status(500).json({
        success: false,
        error: "Salesforce access token not configured",
        details: {
          message: "SF_ACCESS_TOKEN environment variable is missing. Please configure it on Render dashboard."
        }
      });
    }

    const sfURL = `${process.env.SF_INSTANCE_URL}/services/apexrest/caseService`;
    console.log("✅ SF_INSTANCE_URL:", process.env.SF_INSTANCE_URL);
    console.log("✅ SF_ACCESS_TOKEN set:", !!process.env.SF_ACCESS_TOKEN);
    
    const casePayload = {
      operation: "insert",
      subject: caseType,                        // <-- mapped from old Subject
      description: issueDesc,                    // <-- new field
      origin: "Phone",
      priority: "Medium",

      accountId: "",
      contactId: "",

      user_name: user_name,
      email: " ",                       // replace if needed
      mobile: mobile,
      pincode: pincode,

      preferred_date: preferred_date,              // YYYY-MM-DD
      preferred_time: preferred_time,         // "10:00 AM"

      issuedesc: issueDesc,
      fulladdress: fullAddress,

      transcript: transcriptedData,
      recording_link: recordingURL,
      sentiment: "Neutral",
      conversationDueration: conversationDueration,

      workTypeId: "08qC10000000Vn2IAE",          // hardcoded or dynamic
      assetId: "02iC1000000RvF7IAK",             // hardcoded or dynamic

      schedStartTime: schedStartTime,            // "2025-01-12 10:00:00"
      schedEndTime: schedEndTime                 // "2025-01-12 12:00:00"
    };

    const sfHeaders = {
      Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    };

    console.log("📤 Salesforce Request URL:", sfURL);
    console.log("📤 Salesforce Request Headers:", { ...sfHeaders, Authorization: "Bearer [REDACTED]" });
    console.log("📤 Salesforce Request Payload:", JSON.stringify(casePayload, null, 2));

    let sfResponse;
    try {
      sfResponse = await axios.post(sfURL, casePayload, { headers: sfHeaders, httpsAgent: agent });
    } catch (error) {
      console.error("❌ Salesforce API Error Details:", {
        message: error.message,
        code: error.code,
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        config: {
          url: error.config?.url,
          method: error.config?.method,
          headers: error.config?.headers,
        }
      });

      if (error.response?.data?.[0]?.errorCode === 'INVALID_SESSION_ID') {
        console.log("🔄 Session expired, refreshing token...");
        await refreshSalesforceToken();
        // Retry the request with new token
        sfResponse = await axios.post(sfURL, casePayload, { 
          headers: { ...sfHeaders, Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}` },
          httpsAgent: agent 
        });
      } else {
        throw error;
      }
    }

    console.log("Salesforce Case created:", sfResponse.data);

    const caseId = 'SR-'+ sfResponse.data.caseNumber; // You can replace this dynamically
    const email = sfResponse.data.email || ' ';
    const issueDescription = issueDesc || "";
    const registeredAddress = fullAddress || "";
    const serviceTime = new Date(technician_visit_date).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });

    //step 2 to send email to customer

   const emailHTML = `
  <h2 style="color: #004d40;">Greaves Electric Mobility – Service Update</h2>

  <p>Dear ${user_name},</p>

  <p>We have received your request regarding <b>${issueDescription}</b>.</p>

  <p>
    <b>Case ID:</b> ${caseId}<br/>
  </p>

  <p>
    <b>Registered Address:</b><br/>
    ${registeredAddress}<br/>
    <b>Service Time:</b> ${serviceTime}
  </p>

  <p>
    <b>Registered Phone:</b> ${mobile}<br/>
    <b>Registered Email:</b> ${email}
  </p>

  <p style="margin-top: 30px;">Regards,<br/><b>Greaves Electric Mobility Support Team</b></p>
`;


    const emailResponse = await sendMail({
      to: email,
      subject: `Greaves Electric Mobility – Service Update — Case ${caseId}`,
      html: emailHTML,
    });

    //step 3 to send whatsapp message to customer

const parameters = [
  `${user_name}`,
  `${predDate}`,
  `${fullAddress}`,
  `${registration_number}`,
  `${issueDesc}`
];
    const whatsappMobile = mobile.replace(/^(\+91|91)/, '');
    const whatsappPayload = {
      "messaging_product": "whatsapp",
      "to": "91" + whatsappMobile,
      "type": "template",
      "template": {
        "name": "greaves_service_demo",
        "language": { "code": "en" },
        "components": [
          {
            "type": "body",
            "parameters": parameters.map((text) => ({ type: "text", text })),
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
console.log("WhatsApp message sent:", whatsappResponse.data);
    res.status(200).json({
      success: true,
      message: "Salesforce Case created, and WhatsApp message delivered",
      salesforceResponse: sfResponse.data,
      whatsappResponse: whatsappResponse.data,
      schedStartTime: schedStartTime,       
    schedEndTime: schedEndTime    
    });
  } catch (error) {
    console.error("❌ Webhook error:", {
      message: error.message,
      code: error.code,
      statusCode: error.response?.status,
      data: error.response?.data,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message || "Internal Server Error",
      details: {
        message: error.message,
        code: error.code,
      }
    });
  }
});

module.exports = router;
