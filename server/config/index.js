require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT || '3001', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    // Tabbly AI
    tabbly: {
        apiKey: process.env.TABBLY_API_KEY || '',
        organization: process.env.TABBLY_ORGANIZATION_ID || '',
        phoneNumber: process.env.TABBLY_PHONE_NUMBER  || '',
        agentName: process.env.TABBLY_AGENT_NAME || '',
        voiceid : process.env.TABBLY_VOICE_ID || '',
        agentid : process.env.TABBLY_AGENT_ID || '',
    },

    // Webhook
    webhookBaseUrl: process.env.WEBHOOK_BASE_URL || 'http://localhost:3001',

    // Redis (required for BullMQ)
    redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
    },

    // Campaign
    campaign: {
        maxConcurrentCalls: parseInt(process.env.MAX_CONCURRENT_CALLS || '5', 10),
        retryAttempts: parseInt(process.env.CALL_RETRY_ATTEMPTS || '2', 10),
        retryDelayMs: parseInt(process.env.CALL_RETRY_DELAY_MS || '30000', 10),
    },

    // BullMQ Queue
    queue: {
        concurrency: parseInt(process.env.QUEUE_CONCURRENCY || '5', 10),
        jobTtl: parseInt(process.env.QUEUE_JOB_TTL || String(24 * 60 * 60 * 1000), 10),
    },

    // TRAI compliance -- outbound calls only permitted 9 AM-9 PM IST
    trai: {
        callWindowStart: parseInt(process.env.TRAI_CALL_WINDOW_START || '9', 10),
        callWindowEnd: parseInt(process.env.TRAI_CALL_WINDOW_END || '21', 10),
        timezone: process.env.TRAI_TIMEZONE || 'Asia/Kolkata',
        enforce: process.env.TRAI_ENFORCE !== 'false', // default true
    },

    // OpenAI (used for test agent chat endpoint)
    openai: {
        apiKey: process.env.OPENAI_API_KEY || '',
    },

    // ElevenLabs -- direct API access (for test agent TTS)
    // Get voice_id + API key from ElevenLabs dashboard
    elevenlabs: {
        apiKey: process.env.ELEVENLABS_API_KEY || '',
        voiceId: process.env.ELEVENLABS_VOICE_ID || '',
        voiceName: process.env.ELEVENLABS_VOICE_NAME || '',
    },

    // Defaults
    defaults: {
        language: process.env.DEFAULT_LANGUAGE || 'hinglish',
        dealerName: process.env.DEFAULT_DEALER_NAME || 'Godrej Support',
        dealerAddress: process.env.DEFAULT_DEALER_ADDRESS || 'Godrej Service Network, Bengaluru',
        dealerPhone: process.env.DEFAULT_DEALER_PHONE || '+919876543210',
    },
};

module.exports = config;
