const config = require('../config');
const logger = require('../utils/logger');
const GREETING_AGENT_PROMPT = require('../prompts/greeting');
const QUALIFICATION_AGENT_PROMPT = require('../prompts/qualification');
const SERVICE_ADVISOR_PROMPT = require('../prompts/serviceAdvisor');
const BOOKING_AGENT_PROMPT = require('../prompts/booking');
const CLOSING_AGENT_PROMPT = require('../prompts/closing');
const buildLanguageSections = require('../prompts/languageSections');

/**
 * Multi-Agent Squad Definitions for Godrej Appliances Support
 *
 * Each squad agent has a focused prompt with:
 * - Clear role & boundaries
 * - Variable placeholders from CSV data
 * - Language handling (Hindi/English/Hinglish)
 * - Conversation guardrails
 * - Handoff conditions
 *
 * Prompts live in server/prompts/ for easy editing.
 * This file handles agent config, voice pipeline, and prompt assembly.
 */

// ─── Template Variable Injector ──────────────────────────────

function injectVariables(template, variables) {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
        result = result.replace(regex, value || '');
    }
    return result;
}

// ─── Build Complete Agent Configuration ──────────────────────

/**
 * Build a complete Tabbly agent configuration for a campaign contact.
 * Uses one unified prompt that contains all logical squad phases.
 */
function buildAgentConfig(variables, campaignConfig = {}) {
    const language = variables.preferred_language || config.defaults.language;
    const agentName = config.tabbly.agentName || `GodrejSupport_${variables.customer_name}_${Date.now()}`;

    // Build the unified agent prompt that encompasses all squad roles
    const unifiedPrompt = buildUnifiedPrompt(variables);

    // ── Voice Quality & Latency Pipeline ─────────────────────────
    // Target: 600-900ms end-to-end (speech end → first audio chunk)
    // Pipeline: Deepgram STT (250ms) → gpt-4o-mini (200-400ms) → ElevenLabs (200-300ms)

    // ── Tabbly Agent API — component configs ─────────────────────

    const llmAgent = {
        agent_type: 'simple_llm_agent',
        agent_flow_type: 'streaming',
        // gpt-4o-mini: fastest first-token for voice (~200-400ms)
        // Raise max_tokens to prevent the agent's replies from getting cut off mid-sentence
        llm_config: {
            provider: 'openai',
            family: 'openai',
            model: 'gpt-4o-mini',
            max_tokens: 150,
            temperature: 0.3,
            top_p: 0.8,
        },
    };

    // Voice configuration:
    // Use Tabbly voice ID if available, fall back to ElevenLabs config, then default
    const DEFAULT_VOICE_ID = campaignConfig.voiceId || config.tabbly.voiceid || config.elevenlabs.voiceId || 'broqrJkktxd1CclKTudW';
    const DEFAULT_VOICE_NAME = campaignConfig.voiceName || config.elevenlabs.voiceName || 'Anika';

    // Warn if voice configuration is incomplete
    if (config.elevenlabs.voiceId && !config.elevenlabs.voiceName) {
        logger.warn('[AgentSquads] ELEVENLABS_VOICE_ID is set but ELEVENLABS_VOICE_NAME is missing — voice may not change until both are set.');
    }
    if (!config.elevenlabs.voiceId && config.elevenlabs.voiceName) {
        logger.warn('[AgentSquads] ELEVENLABS_VOICE_NAME is set but ELEVENLABS_VOICE_ID is missing — voice may not change until both are set.');
    }

    // ---------------------------------------------------------------------------------
    // VOICE QUALITY & CLARITY CONFIGURATION
    // These are the primary settings for controlling the voice.
    // ---------------------------------------------------------------------------------
    const synthProviderConfig = {
        voice: DEFAULT_VOICE_NAME,
        voice_id: DEFAULT_VOICE_ID,
        // eleven_multilingual_v2: best Indian accent support, natural multilingual output
        model: 'eleven_flash_v2_5',
        language_code: language === 'hindi' ? 'hi' : language === 'hinglish' ? 'hi' : 'en',
        // Lower-latency voice settings with enough stability for number readbacks
        stability: 0.82,                // 0.0 (more variable) to 1.0 (more stable). Higher is better for clarity.
        similarity_boost: 0.68,         // 0.0 to 1.0. Lower values are more expressive.
        style: 0.15,                    // 0.0 to 1.0. Lower style reduces synthesis overhead and variation.
        speed: 0.93,                    // 0.5 (slowest) to 2.0 (fastest).
        optimize_streaming_latency: 3,  // 0-4. Balanced chunk generation for latency vs. cadence.
    };

    const synthesizer = {
        provider: 'elevenlabs',
        provider_config: synthProviderConfig,
        stream: true,
        buffer_size: 80,  // Balanced buffer length to ensure sentences have enough context to not sound robotic
        audio_format: 'wav',
    };

    const transcriber = {
        provider: 'deepgram',
        // transcriber fields are top-level (not nested in provider_config)
        model: 'nova-3',
        language: language === 'hindi' ? 'hi' : language === 'hinglish' ? 'hi' : 'en',
        stream: true,
        sampling_rate: 8000,
        encoding: 'mulaw',
        // Faster turn detection to reduce agent wait time after user speech ends
        endpointing: 50,
        utterance_end_ms: 100,
        // no_delay=true: Deepgram returns partial results immediately, reduces STT latency
        no_delay: true,
    };

    // Tabbly Agent API structure: { agent_config: {...}, agent_prompts: {...} }
    const agentConfig = {
        agent_config: {
            agent_name: agentName,
            agent_id: config.tabbly.agentid || undefined,
            agent_type: 'other',
            agent_welcome_message: buildWelcomeMessage(variables),
            webhook_url: `${config.webhookBaseUrl}/api/v1/webhooks/tabbly`,
            tasks: [
                {
                    task_type: 'conversation',
                    tools_config: {
                        llm_agent: llmAgent,
                        synthesizer: synthesizer,
                        transcriber: transcriber,
                        input: {
                            provider: 'plivo',
                            format: 'wav',
                        },
                        output: {
                            provider: 'plivo',
                            format: 'wav',
                        },
                    },
                    task_config: {
                        // Lower chunk handoff delay improves response latency for the newly small chunks
                        incremental_delay: 45,
                        optimize_latency: true,
                        hangup_after_silence: 8,
                        // 3 words to interrupt — stops the agent from getting cut off by simple static/heavy breaths
                        number_of_words_for_interruption: 2,
                        // 2400 seconds max call duration
                        call_terminate: 2400,
                        hangup_after_LLMCall: false,
                        // Trigger hangup when agent says goodbye phrase
                        call_cancellation_prompt: 'Your comfort is our priority',
                        // Voicemail detection — auto-disconnect if voicemail picks up
                        voicemail: true,
                        // Enable backchanneling to mask initial high latency with filler words
                        backchanneling: true,
                        // Disable ambient noise to reduce synthesis complexity
                        ambient_noise: false,
                    },
                    toolchain: {
                        execution: 'sequential',
                        pipelines: [['transcriber', 'llm', 'synthesizer']],
                    },
                },
            ],
        },
        agent_prompts: {
            task_1: {
                system_prompt: unifiedPrompt,
            },
        },
    };

    return agentConfig;
}

/**
 * Build the unified multi-agent prompt
 */
function buildUnifiedPrompt(variables) {
    const vars = {
        customer_name: variables.customer_name || 'Customer',
        phone_number: variables.phone_number || '',
        customer_type: variables.customer_type || 'customer',
        dealer_number: variables.dealer_number || '',
        product_category: variables.product_category || '',
        product_name: variables.product_name || variables.vehicle_model || 'Godrej appliance',
        model_number: variables.model_number || '',
        serial_number: variables.serial_number || '',
        purchase_date: variables.purchase_date || '',
        warranty_status: variables.warranty_status || '',
        address: variables.address || '',
        pincode: variables.pincode || '',
        issue_summary: variables.issue_summary || '',
        vehicle_model: variables.vehicle_model || '',
        vehicle_year: variables.vehicle_year || '',
        vehicle_registration: variables.vehicle_registration || '',
        last_service_date: variables.last_service_date || '',
        preferred_language: variables.preferred_language || config.defaults.language,
        dealer_name: variables.dealer_name || 'Godrej Support',
        dealer_address: variables.dealer_address || config.defaults.dealerAddress,
        dealer_phone: variables.dealer_phone || config.defaults.dealerPhone,
    };

    const header = `
# GODREJ APPLIANCES SUPPORT AGENT — MASTER INSTRUCTIONS

You are Naina — a FEMALE customer-support professional from ${vars.dealer_name}.
You handle support for Godrej electrical and electronic appliances such as AC, refrigerator, washing machine, microwave oven, dishwasher, and similar home appliances.
You are currently speaking with ${vars.customer_name}.

${buildLanguageSections(vars.preferred_language)}

## CRITICAL RULES (Follow these AT ALL TIMES):
1. SPEAK ONLY in ${vars.preferred_language} throughout the call
2. Sound exactly like a REAL professional female call center agent — warm, confident, natural
3. NEVER reveal you are an AI or automated system
4. STAY STRICTLY on Godrej appliance support topics — redirect anything else politely
5. NEVER re-ask what you already know once it has been confirmed
6. Be CALM, POLITE, and CONFIDENT at all times
7. Ask ONE question per turn — wait for full answer before continuing
8. Keep responses SHORT — 1 to 2 sentences maximum. Never cram multiple topics into one long sentence.
9. If customer is rude or angry, stay calm and follow a de-escalation path
10. NEVER mention competitor brands or unrelated product lines
11. ADDRESS THE CUSTOMER respectfully as "Sir" or "Ma'am" after identity is clear
12. Do not promise resolution, replacement, refund, or visit time outside stated process
13. Godrej support scope is limited to Godrej appliances only
14. Use the customer's confirmed name pronunciation consistently
15. For hindi and hinglish output, write ALL Hindi-origin words in Devanagari script. Do NOT write Roman Hindi such as "main", "aap", "bol rahi hoon", "samajh gaya", "theek hai".
16. In hinglish, only true English-origin support words may remain in Roman, such as "service", "complaint", "model number", "serial number", "warranty", "SMS", and "installation".
17. When speaking or confirming phone numbers, pincodes, or model/serial numbers:
    - In hindi and hinglish, speak digits in Hindi words only
    - In english, speak digits in English words only
    - Speak every letter separately for alphanumeric codes
    - Insert natural comma pauses between chunks
    - Slow down slightly the FIRST time you say the value and every time you repeat it
    - Never say a number or alphanumeric code in a rushed sentence like a normal phrase
18. SYSTEM AUTO-GREETING: The phone system automatically says "May I please speak with ${vars.customer_name}?" before you even connect.
    - Therefore, the customer's identity is ALREADY 100% CONFIRMED. 
    - NEVER say "Am I speaking with ${vars.customer_name}?" or "Did I hear your name correctly as ${vars.customer_name}?".
    - Move straight to helping them or confirming their phone number/issue.
19. Customer vs Dealer Identification:
    - If customer_type is already provided as "${vars.customer_type}" (and is "customer" or "dealer"), DO NOT ask "Are you a customer or dealer?".
    - ONLY ask if they are a customer or a dealer if the record is missing, "not available", or if this is an inbound call where their identity isn't pre-verified.

## KNOWN CONTEXT
- Customer type: ${vars.customer_type}
- Phone number: ${vars.phone_number}
- Dealer number: ${vars.dealer_number || 'not available'}
- Product category: ${vars.product_category || 'not available'}
- Product name: ${vars.product_name || 'not available'}
- Model number: ${vars.model_number || 'not available'}
- Serial number: ${vars.serial_number || 'not available'}
- Purchase date: ${vars.purchase_date || 'not available'}
- Warranty status: ${vars.warranty_status || 'not available'}
- Address: ${vars.address || 'not available'}
- Pincode: ${vars.pincode || 'not available'}
- Existing issue summary: ${vars.issue_summary || 'not available'}

## NUMBER HANDLING — CRITICAL RULES:

### Understanding Numbers (Input):
Users may speak numbers in any of these formats — understand and record the full digit sequence:
- Hindi digit words: ek=1, do=2, teen=3, char=4, panch=5, chhe=6, saat=7, aath=8, no/nau=9, shunya=0
- Hindi compound words: gyarah=11, barah=12, terah=13, chaudah=14, pandrah=15, solah=16, satrah=17, atharah=18, unnees=19, bees=20, pachaas=50, saath=60 (different from "saat"), sattar=70, assi=80, nabbe=90
- English digit words: zero=0, one=1, two=2, three=3, four=4, five=5, six=6, seven=7, eight=8, nine=9
- "double X" → two of that digit; "triple X" → three of that digit
- Always assemble digits in sequence

Examples of correct interpretation:
- "no panch saat ek no shunya ek ek aath shunya" → 9571901180
- "nine five seven one nine zero double one eight zero" → 9571901180
- "teen shunya do shunya ek nau" → 302019
- "A B C one two three four" → ABC1234

(See number output format in the PRONUNCIATION RULES section above.)

## CONVERSATION FLOW:
Follow this exact sequence. Move to next phase only when current phase is complete.

### PHASE 1: GREETING & LANGUAGE LOCK
${injectVariables(GREETING_AGENT_PROMPT, vars)}

### PHASE 2: IDENTITY VERIFICATION
${injectVariables(QUALIFICATION_AGENT_PROMPT, vars)}

### PHASE 3: REQUIREMENT DISCOVERY
${injectVariables(SERVICE_ADVISOR_PROMPT, vars)}

### PHASE 4: CASE HANDLING & REQUEST ACTION
${injectVariables(BOOKING_AGENT_PROMPT, vars)}

### PHASE 5: CONFIRMATION & CLOSING
${injectVariables(CLOSING_AGENT_PROMPT, vars)}

## EXTRACTION (after call ends):
Identify and return the following from the conversation:
- customer_type: customer or dealer
- request_type: one of [complaint, service_request, installation, warranty, product_info, return_replacement, escalation, feedback, other]
- call_outcome: one of [request_registered, info_shared, escalated, callback, no_answer, busy, out_of_scope, unresolved]
- product_category: appliance category if identified
- product_name: appliance name if identified
- model_number: model if shared
- serial_number: serial if shared
- issue_summary: short summary of the issue or need
- service_request_number: request or complaint number if generated
- csn: CSN if generated
- escalation_status: none, escalated, high_priority, senior_transfer
- visit_window: promised visit/contact window if stated
- customer_notes: any special customer instruction or note
`;

    return header;
}

/**
 * Build welcome message based on language
 */
function buildWelcomeMessage(variables) {
    const lang = variables.preferred_language || config.defaults.language;
    const name = variables.customer_name || 'Customer';
    const dealer = variables.dealer_name || 'Godrej Support';

    if (lang === 'hindi') {
        return `\u0928\u092E\u0938\u094D\u0924\u0947, \u092E\u0948\u0902 \u0928\u0948\u0928\u093E, ${dealer} \u0938\u0947 \u092C\u094B\u0932 \u0930\u0939\u0940 \u0939\u0942\u0901\u0964 \u0915\u094D\u092F\u093E \u092E\u0948\u0902 ${name} \u0938\u0947 \u092C\u093E\u0924 \u0915\u0930 \u0938\u0915\u0924\u0940 \u0939\u0942\u0901?`;
    } else if (lang === 'hinglish') {
        return `\u0928\u092E\u0938\u094D\u0924\u0947, \u092E\u0948\u0902 \u0928\u0948\u0928\u093E, ${dealer} \u0938\u0947 \u092C\u094B\u0932 \u0930\u0939\u0940 \u0939\u0942\u0901\u0964 \u0915\u094D\u092F\u093E \u092E\u0948\u0902 ${name} \u0938\u0947 \u092C\u093E\u0924 \u0915\u0930 \u0938\u0915\u0924\u0940 \u0939\u0942\u0901?`;
    } else {
        return `Hello, this is Naina from ${dealer}. May I please speak with ${name}?`;
    }
}

// ─── Get Individual Squad Prompts for UI Display ─────────────

function getSquadPrompts() {
    return {
        greeting: {
            name: 'Greeting Agent',
            description: 'Opening greeting, support introduction, and language lock',
            prompt: GREETING_AGENT_PROMPT,
        },
        qualification: {
            name: 'Verification Agent',
            description: 'Name, role, contact, and detail confirmation',
            prompt: QUALIFICATION_AGENT_PROMPT,
        },
        serviceAdvisor: {
            name: 'Discovery Agent',
            description: 'Appliance issue discovery and request classification',
            prompt: SERVICE_ADVISOR_PROMPT,
        },
        booking: {
            name: 'Case Handling Agent',
            description: 'Request registration, process explanation, and escalation',
            prompt: BOOKING_AGENT_PROMPT,
        },
        closing: {
            name: 'Closing Agent',
            description: 'Final recap, next steps, and professional closure',
            prompt: CLOSING_AGENT_PROMPT,
        },
    };
}

module.exports = {
    buildAgentConfig,
    buildUnifiedPrompt,
    buildWelcomeMessage,
    injectVariables,
    getSquadPrompts,
    GREETING_AGENT_PROMPT,
    QUALIFICATION_AGENT_PROMPT,
    SERVICE_ADVISOR_PROMPT,
    BOOKING_AGENT_PROMPT,
    CLOSING_AGENT_PROMPT,
};
