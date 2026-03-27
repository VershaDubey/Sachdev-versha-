const axios = require('axios');
const CircuitBreaker = require('opossum');
const config = require('../config');
const logger = require('../utils/logger');

const tabblyApi = axios.create({
    baseURL: `https://api.tabbly.ai`,
    headers: {
        'Authorization': `Bearer ${config.tabbly.apiKey}`,
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

// ─── Retry with Exponential Backoff ──────────────────────────

async function withRetry(fn, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            // Log the full Tabbly API error so we can diagnose the root cause
            const httpStatus = err.response?.status;
            const httpBody = err.response?.data;
            logger.error('[TabblyService] API call failed', {
                attempt,
                maxAttempts,
                httpStatus,
                httpBody,
                error: err.message,
                code: err.code,
            });
            const isTransient = !err.response || err.response.status >= 500 || err.code === 'ECONNABORTED';
            if (!isTransient || attempt === maxAttempts) break;
            const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
            logger.warn('[TabblyService] Retrying after transient error', { attempt, delayMs });
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastError;
}

// ─── Circuit Breaker ──────────────────────────────────────────

const breakerOptions = {
    timeout: 30000,
    errorThresholdPercentage: 50,
    resetTimeout: 60000,
    // volumeThreshold: minimum number of calls before the circuit can open.
    // Set to 10 to avoid premature opening during startup/low-traffic periods.
    volumeThreshold: 10,
};

function makeBreaker(fn, name) {
    const breaker = new CircuitBreaker(fn, breakerOptions);
    breaker.fallback(() => {
        throw new Error(`Tabbly API circuit open for ${name} — service may be degraded`);
    });
    breaker.on('open', () => logger.warn('[TabblyService] Circuit opened', { name }));
    breaker.on('halfOpen', () => logger.info('[TabblyService] Circuit half-open (probing)', { name }));
    breaker.on('close', () => logger.info('[TabblyService] Circuit closed (recovered)', { name }));
    return breaker;
}

// ─── Agent Management ────────────────────────────────────────

async function _createAgentFn(agentConfig) {
    // Debug: log synthesizer config to verify voice_id is present
    const synthCfg = agentConfig?.agent_config?.tasks?.[0]?.tools_config?.synthesizer;
    logger.info('[TabblyService] Creating agent — synthesizer config', {
        provider: synthCfg?.provider,
        voice: synthCfg?.provider_config?.voice,
        voice_id: synthCfg?.provider_config?.voice_id,
        model: synthCfg?.provider_config?.model,
        language_code: synthCfg?.provider_config?.language_code,
    });
    return withRetry(() => tabblyApi.post('/v2/agent', agentConfig));
}
const createAgentBreaker = makeBreaker(_createAgentFn, 'createAgent');

async function createAgent(agentConfig) {
    try {
        const response = await createAgentBreaker.fire(agentConfig);
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Create agent error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

async function getAgent(agentId) {
    try {
        const response = await tabblyApi.get(`/agent/${agentId}`);
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Get agent error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

async function updateAgent(agentId, agentConfig) {
    try {
        const response = await tabblyApi.put(`/v2/agent/${agentId}`, agentConfig);
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Update agent error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

async function listAgents() {
    try {
        const response = await tabblyApi.get('/agent/all');
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] List agents error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

async function deleteAgent(agentId) {
    try {
        const response = await tabblyApi.delete(`/agent/${agentId}`);
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Delete agent error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

// ─── Call Management ─────────────────────────────────────────

async function _makeCallFn({ agentId, recipientPhone, fromPhone }) {
    const payload = {
        agent_id: agentId,
        recipient_phone_number: recipientPhone,
    };
    // Only include from_phone_number if explicitly provided — Tabbly uses its account default otherwise
    if (fromPhone) payload.from_phone_number = fromPhone;
    return withRetry(() => tabblyApi.post('/call', payload));
}
const makeCallBreaker = makeBreaker(_makeCallFn, 'makeCall');

async function makeCall(agentId, recipientPhone, fromPhone) {
    try {
        const response = await makeCallBreaker.fire({ agentId, recipientPhone, fromPhone });
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Make call error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

async function stopCall(callId) {
    try {
        const response = await tabblyApi.post('/call/stop', { call_id: callId });
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Stop call error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

// ─── Execution / Transcript ──────────────────────────────────

async function getExecution(executionId) {
    try {
        const response = await tabblyApi.get(`/execution/${executionId}`);
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Get execution error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

async function getAgentExecutions(agentId) {
    try {
        const response = await tabblyApi.get(`/agent_executions/${agentId}`);
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Get agent executions error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

async function getExecutionLogs(executionId) {
    try {
        const response = await tabblyApi.get(`/execution/${executionId}/raw_logs`);
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] Get execution logs error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

// ─── Phone Number Management ─────────────────────────────────

async function listPhoneNumbers() {
    try {
        const response = await tabblyApi.get('/phone_numbers');
        return { success: true, data: response.data };
    } catch (error) {
        logger.error('[TabblyService] List phone numbers error', { error: error.response?.data || error.message });
        return { success: false, error: error.response?.data || error.message };
    }
}

module.exports = {
    createAgent,
    getAgent,
    updateAgent,
    listAgents,
    deleteAgent,
    makeCall,
    stopCall,
    getExecution,
    getAgentExecutions,
    getExecutionLogs,
    listPhoneNumbers,
};
