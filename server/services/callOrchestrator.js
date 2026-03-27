const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const tabblyService = require('./tabblyService');
const agentSquads = require('./agentSquads');
const db = require('../db/database');
const { addCallJob } = require('./queue');
const logger = require('../utils/logger');

/**
 * Call Orchestrator — Manages campaign execution via BullMQ
 *
 * Replaces setInterval polling with Redis-backed job queue.
 * Handles: DNC checks, TRAI call-window enforcement, circuit breaker,
 * extraction validation, and campaign recovery on restart.
 */

let io = null;
const activeCampaigns = new Set(); // campaignIds currently running

function setSocketIO(socketIO) {
    io = socketIO;
}

function emit(event, data) {
    if (io) io.emit(event, data);
}

// ─── TRAI Compliance ──────────────────────────────────────────

/**
 * Returns true if the current time in IST is within the allowed call window.
 * TRAI mandates outbound calls only between 09:00 – 21:00 IST.
 */
function isWithinCallWindow() {
    if (!config.trai.enforce) return true;

    const now = new Date();
    const istTime = new Intl.DateTimeFormat('en-IN', {
        timeZone: config.trai.timezone,
        hour: 'numeric',
        hour12: false,
    }).format(now);

    const hour = parseInt(istTime, 10);
    return hour >= config.trai.callWindowStart && hour < config.trai.callWindowEnd;
}

/**
 * Returns milliseconds until the next call window opens (next 09:00 IST).
 */
function msUntilWindowOpens() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-IN', {
        timeZone: config.trai.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const p = {};
    parts.forEach(({ type, value }) => { p[type] = value; });

    const nextOpen = new Date(
        `${p.year}-${p.month}-${p.day}T${String(config.trai.callWindowStart).padStart(2, '0')}:00:00+05:30`
    );
    if (nextOpen <= now) nextOpen.setDate(nextOpen.getDate() + 1);
    return Math.max(0, nextOpen.getTime() - now.getTime());
}

// ─── Campaign Execution ──────────────────────────────────────

/**
 * Start a campaign — enqueues all queued contacts as BullMQ jobs.
 */
async function startCampaign(campaignId) {
    const campaign = db.getCampaign(campaignId);
    if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
    if (campaign.status === 'running') throw new Error(`Campaign ${campaignId} is already running`);

    logger.info('[Orchestrator] Starting campaign', { campaignId, name: campaign.name });

    db.updateCampaign(campaignId, { status: 'running', started_at: new Date().toISOString() });
    activeCampaigns.add(campaignId);
    emit('campaign:status', { campaignId, status: 'running' });

    await _enqueueNextBatch(campaignId);

    return db.getCampaign(campaignId);
}

/**
 * Stop a running campaign.
 */
async function stopCampaign(campaignId) {
    activeCampaigns.delete(campaignId);
    db.updateCampaign(campaignId, { status: 'paused' });
    emit('campaign:status', { campaignId, status: 'paused' });
    logger.info('[Orchestrator] Campaign stopped', { campaignId });
    return db.getCampaign(campaignId);
}

/**
 * Recover running campaigns after server restart.
 * Resets stuck in-progress contacts back to queued and re-enqueues them.
 */
async function recoverRunningCampaigns() {
    const running = db.getRunningCampaigns();
    if (running.length === 0) return;

    logger.info('[Orchestrator] Recovering running campaigns on restart', { count: running.length });

    for (const campaign of running) {
        // Reset any contacts that were mid-call when server died
        db.resetInProgressContacts(campaign.id);
        activeCampaigns.add(campaign.id);
        await _enqueueNextBatch(campaign.id);
        logger.info('[Orchestrator] Campaign recovered', { campaignId: campaign.id, name: campaign.name });
    }
}

// ─── Queue Processing ────────────────────────────────────────

/**
 * Enqueue the next batch of queued contacts up to the concurrency limit.
 * Called after a call completes to keep the pipeline full.
 */
async function _enqueueNextBatch(campaignId) {
    const campaign = db.getCampaign(campaignId);
    if (!campaign || campaign.status !== 'running') return;

    const contacts = db.getCampaignContacts(campaignId);
    const activeCalls = contacts.filter(c => c.status === 'in-progress').length;
    const slots = config.campaign.maxConcurrentCalls - activeCalls;

    if (slots <= 0) return;

    const queued = db.getQueuedContacts(campaignId, slots);

    if (queued.length === 0) {
        const remaining = contacts.filter(c => c.status === 'queued' || c.status === 'in-progress');
        if (remaining.length === 0) {
            completeCampaign(campaignId);
        }
        return;
    }

    // Enforce TRAI call window — delay jobs until window opens
    const delayMs = isWithinCallWindow() ? 0 : msUntilWindowOpens();

    if (delayMs > 0) {
        const minutesUntilOpen = Math.round(delayMs / 60000);
        logger.warn('[Orchestrator] Outside TRAI call window — delaying jobs', {
            campaignId,
            minutesUntilOpen,
        });
    }

    for (const contact of queued) {
        // Mark as dialing immediately so we don't double-enqueue
        db.updateContact(contact.id, { status: 'dialing' });
        emit('contact:status', {
            campaignId,
            contactId: contact.id,
            status: 'dialing',
            customerName: contact.customer_name,
            phoneNumber: contact.phone_number,
        });

        await addCallJob(contact.id, campaignId, delayMs);
    }
}

// ─── Call Initiation (called by queue worker) ────────────────

/**
 * The main work function executed by the BullMQ worker for each job.
 */
async function processCallJob(contactId, campaignId) {
    const contact = db.getContact(contactId);
    if (!contact) {
        logger.warn('[Orchestrator] Contact not found for job', { contactId });
        return;
    }

    const campaign = db.getCampaign(campaignId);
    if (!campaign || campaign.status !== 'running') {
        logger.info('[Orchestrator] Campaign no longer running — skipping job', { campaignId, contactId });
        // Reset contact to queued so it can be re-processed if campaign restarts
        db.updateContact(contactId, { status: 'queued' });
        return;
    }

    await initiateCall(campaignId, contact);

    // After this call was initiated, try to fill next slot
    await _enqueueNextBatch(campaignId);
}

/**
 * Initiate a single call for one contact.
 */
async function initiateCall(campaignId, contact) {
    const campaign = db.getCampaign(campaignId);
    const campaignConfig = JSON.parse(campaign.config_json || '{}');

    // ── DNC Check ──────────────────────────────────────────────
    if (db.isPhoneOnDNC(contact.phone_number)) {
        logger.warn('[Orchestrator] Contact on DNC list — skipping', {
            contactId: contact.id,
            phone: contact.phone_number,
        });
        db.updateContact(contact.id, {
            status: 'failed',
            call_outcome: 'dnc',
            notes: 'Number is on the Do Not Call list.',
        });
        db.insertCallLog({
            id: uuidv4(),
            campaignId,
            contactId: contact.id,
            eventType: 'call_skipped_dnc',
            eventData: { phone: contact.phone_number },
        });
        emit('contact:status', {
            campaignId,
            contactId: contact.id,
            status: 'failed',
            customerName: contact.customer_name,
            phoneNumber: contact.phone_number,
        });
        db.updateCampaignStats(campaignId);
        return;
    }

    // ── Build variables — per-contact language wins over campaign default ──
    const variables = {
        customer_name: contact.customer_name,
        phone_number: contact.phone_number,
        customer_type: contact.customer_type || 'customer',
        dealer_number: contact.dealer_number || '',
        product_category: contact.product_category || '',
        product_name: contact.product_name || contact.vehicle_model || '',
        model_number: contact.model_number || '',
        serial_number: contact.serial_number || '',
        purchase_date: contact.purchase_date || contact.vehicle_year || '',
        warranty_status: contact.warranty_status || '',
        address: contact.address || '',
        pincode: contact.pincode || '',
        issue_summary: contact.issue_summary || '',
        vehicle_model: contact.vehicle_model || '',
        vehicle_year: contact.vehicle_year || '',
        vehicle_registration: contact.vehicle_registration || '',
        last_service_date: contact.last_service_date || '',
        // Per-contact language from CSV takes priority over campaign-level language
        preferred_language: contact.preferred_language || campaign.language || config.defaults.language,
        dealer_name: campaign.dealer_name || config.defaults.dealerName,
        dealer_address: campaign.dealer_address || config.defaults.dealerAddress,
        dealer_phone: campaign.dealer_phone || config.defaults.dealerPhone,
    };

    const agentConfig = agentSquads.buildAgentConfig(variables, campaignConfig);

    logger.info('[Orchestrator] Initiating call', {
        contactId: contact.id,
        customer: contact.customer_name,
        phone: contact.phone_number,
        language: variables.preferred_language,
    });

    try {
        let agentId = null;

        // Use Tabbly agent ID from config if available
        if (config.tabbly.agentid) {
            agentId = config.tabbly.agentid;
            logger.info('[Orchestrator] Using configured Tabbly agent ID', { agentId });

            // Update the existing agent with the specific customer parameters for this call
            const updateResult = await tabblyService.updateAgent(agentId, agentConfig);
            if (!updateResult.success) {
                logger.warn(`Failed to update existing agent ${agentId}, will try by name or create new.`, { error: updateResult.error });
                agentId = null;
            }
        }

        if (!agentId && config.tabbly.agentName) {
            // Try to find existing agent by name
            const agentsRes = await tabblyService.listAgents();
            if (agentsRes.success && agentsRes.data) {
                const existing = agentsRes.data.find(a => a.agent_name === config.tabbly.agentName);
                if (existing) {
                    agentId = existing.id || existing.agent_id;
                    logger.info('[Orchestrator] Found existing agent by name, updating config', { agentName: config.tabbly.agentName, agentId });

                    // Update the existing agent with the specific customer parameters for this call
                    const updateResult = await tabblyService.updateAgent(agentId, agentConfig);
                    if (!updateResult.success) {
                        logger.warn(`Failed to update existing agent ${agentId}, creating a new one as fallback.`, { error: updateResult.error });
                        agentId = null;
                    }
                }
            }
        }

        if (!agentId) {
            // Create a new Tabbly agent if none found
            logger.info('[Orchestrator] Creating new Tabbly agent', { agentName: config.tabbly.agentName || 'dynamic' });
            const agentResult = await tabblyService.createAgent(agentConfig);
            if (!agentResult.success) {
                throw new Error(`Agent creation failed: ${JSON.stringify(agentResult.error)}`);
            }
            agentId = agentResult.data.agent_id || agentResult.data.id;
        }

        // Dial — use Tabbly phone number
        const callResult = await tabblyService.makeCall(agentId, contact.phone_number, config.tabbly.phoneNumber || undefined);
        if (!callResult.success) {
            throw new Error(`Call initiation failed: ${JSON.stringify(callResult.error)}`);
        }

        const callId = callResult.data.call_id || callResult.data.execution_id || uuidv4();

        db.updateContact(contact.id, {
            status: 'in-progress',
            call_id: callId,
            tabbly_execution_id: callResult.data.execution_id || callId,
            call_started_at: new Date().toISOString(),
        });

        db.insertCallLog({
            id: uuidv4(),
            campaignId,
            contactId: contact.id,
            eventType: 'call_initiated',
            eventData: { agentId, callId, phone: contact.phone_number },
        });

        emit('contact:status', {
            campaignId,
            contactId: contact.id,
            status: 'in-progress',
            customerName: contact.customer_name,
            phoneNumber: contact.phone_number,
            callId,
        });

        const updatedCampaign = db.updateCampaignStats(campaignId);
        _emitStats(campaignId, updatedCampaign);

        logger.info('[Orchestrator] Call started', { contactId: contact.id, callId });

    } catch (error) {
        logger.error('[Orchestrator] Call failed', {
            contactId: contact.id,
            customer: contact.customer_name,
            error: error.message,
        });

        const retryCount = (contact.retry_count || 0) + 1;

        if (retryCount <= config.campaign.retryAttempts) {
            db.updateContact(contact.id, {
                status: 'queued',
                retry_count: retryCount,
                notes: `Retry ${retryCount}: ${error.message}`,
            });
            // BullMQ will retry the job automatically via its backoff policy
        } else {
            db.updateContact(contact.id, {
                status: 'failed',
                call_outcome: 'failed',
                notes: `Failed after ${retryCount} attempts: ${error.message}`,
            });

            db.insertCallLog({
                id: uuidv4(),
                campaignId,
                contactId: contact.id,
                eventType: 'call_failed',
                eventData: { error: error.message, retryCount },
            });

            emit('contact:status', {
                campaignId,
                contactId: contact.id,
                status: 'failed',
                customerName: contact.customer_name,
                phoneNumber: contact.phone_number,
            });
        }

        db.updateCampaignStats(campaignId);
    }
}

// ─── Call Completion (called by webhook processor) ──────────

/**
 * Validate extracted appointment data from the conversation.
 */
function validateExtractedData(extracted) {
    const validated = { ...extracted };

    if (validated.appointment_date) {
        const d = new Date(validated.appointment_date);
        const isValidDate = !isNaN(d.getTime());
        const isFuture = d > new Date();
        if (!isValidDate || !isFuture) {
            logger.warn('[Orchestrator] Invalid appointment_date extracted', { raw: validated.appointment_date });
            validated.appointment_date = null;
        }
    }

    if (validated.appointment_time) {
        // Accept formats: "10:30", "10:30 AM", "10:30 am"
        const timePattern = /^([01]?\d|2[0-3]):[0-5]\d(\s*(AM|PM|am|pm))?$/;
        if (!timePattern.test(String(validated.appointment_time).trim())) {
            logger.warn('[Orchestrator] Invalid appointment_time extracted', { raw: validated.appointment_time });
            validated.appointment_time = null;
        }
    }

    if (validated.customer_type) {
        const normalized = String(validated.customer_type).trim().toLowerCase();
        validated.customer_type = ['customer', 'dealer'].includes(normalized) ? normalized : null;
    }

    if (validated.request_type) {
        const normalized = String(validated.request_type).trim().toLowerCase();
        validated.request_type = normalized || null;
    }

    if (validated.escalation_status) {
        validated.escalation_status = String(validated.escalation_status).trim().toLowerCase() || null;
    }

    return validated;
}

/**
 * Handle call completion — called by webhook processor.
 */
async function handleCallCompleted(contactId, executionData) {
    const contact = db.getContact(contactId);
    if (!contact) {
        logger.error('[Orchestrator] Contact not found for completion', { contactId });
        return;
    }

    const transcript = executionData.transcript || executionData.conversation || [];
    const rawExtracted = executionData.extracted_data || {};
    const extractedData = validateExtractedData(rawExtracted);

    db.updateContact(contactId, {
        status: 'completed',
        call_ended_at: new Date().toISOString(),
        call_duration_seconds: executionData.duration || 0,
        transcript_json: JSON.stringify(transcript),
        call_outcome: extractedData.call_outcome || 'completed',
        customer_type: extractedData.customer_type || contact.customer_type || null,
        issue_summary: extractedData.issue_summary || contact.issue_summary || null,
        appointment_date: extractedData.appointment_date || null,
        appointment_time: extractedData.appointment_time || null,
        service_type: extractedData.service_type || null,
        request_type: extractedData.request_type || null,
        service_request_number: extractedData.service_request_number || null,
        csn: extractedData.csn || null,
        escalation_status: extractedData.escalation_status || null,
        visit_window: extractedData.visit_window || null,
        notes: extractedData.customer_notes || null,
        recording_url: executionData.recording_url || null,
    });

    db.insertCallLog({
        id: uuidv4(),
        campaignId: contact.campaign_id,
        contactId,
        eventType: 'call_completed',
        eventData: executionData,
    });

    const updatedCampaign = db.updateCampaignStats(contact.campaign_id);

    emit('contact:status', {
        campaignId: contact.campaign_id,
        contactId,
        status: 'completed',
        customerName: contact.customer_name,
        phoneNumber: contact.phone_number,
        outcome: extractedData.call_outcome || 'completed',
        duration: executionData.duration || 0,
    });

    _emitStats(contact.campaign_id, updatedCampaign);

    logger.info('[Orchestrator] Call completed', {
        contactId,
        customer: contact.customer_name,
        outcome: extractedData.call_outcome,
        appointmentDate: extractedData.appointment_date,
    });

    // Try to enqueue the next contact now that a slot is free
    if (activeCampaigns.has(contact.campaign_id)) {
        await _enqueueNextBatch(contact.campaign_id);
    }
}

// ─── Campaign Completion ─────────────────────────────────────

function completeCampaign(campaignId) {
    activeCampaigns.delete(campaignId);

    db.updateCampaign(campaignId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
    });

    const campaign = db.updateCampaignStats(campaignId);

    emit('campaign:status', { campaignId, status: 'completed' });
    _emitStats(campaignId, campaign);

    logger.info('[Orchestrator] Campaign completed', { campaignId });
}

// ─── Helpers ─────────────────────────────────────────────────

function _emitStats(campaignId, campaign) {
    emit('campaign:stats', {
        campaignId,
        stats: {
            total: campaign.total_contacts,
            completed: campaign.completed_contacts,
            failed: campaign.failed_contacts,
            active: campaign.active_calls,
            queued: campaign.total_contacts
                - campaign.completed_contacts
                - campaign.failed_contacts
                - campaign.active_calls,
        },
    });
}

module.exports = {
    setSocketIO,
    startCampaign,
    stopCampaign,
    recoverRunningCampaigns,
    processCallJob,
    handleCallCompleted,
};
