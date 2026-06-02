const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Per-model pricing (USD per 1M tokens, standard tier) ───
// cache5m = ephemeral 5min cache write, cache1h = ephemeral 1h cache write (2× of 5m)
const MODEL_PRICING = {
    // Opus 4.x family — all same pricing
    'opus-4':     { input: 15.00, output: 75.00, cache5m: 18.75, cache1h: 30.00, cacheRead: 1.50 },
    'opus-4-1':   { input: 15.00, output: 75.00, cache5m: 18.75, cache1h: 30.00, cacheRead: 1.50 },
    'opus-4-5':   { input: 15.00, output: 75.00, cache5m: 18.75, cache1h: 30.00, cacheRead: 1.50 },
    'opus-4-6':   { input: 15.00, output: 75.00, cache5m: 18.75, cache1h: 30.00, cacheRead: 1.50 },
    'opus-4-7':   { input: 15.00, output: 75.00, cache5m: 18.75, cache1h: 30.00, cacheRead: 1.50 },
    // Sonnet 4.x family
    'sonnet-4':   { input:  3.00, output: 15.00, cache5m:  3.75, cache1h:  6.00, cacheRead: 0.30 },
    'sonnet-4-5': { input:  3.00, output: 15.00, cache5m:  3.75, cache1h:  6.00, cacheRead: 0.30 },
    'sonnet-4-6': { input:  3.00, output: 15.00, cache5m:  3.75, cache1h:  6.00, cacheRead: 0.30 },
    // Haiku 4.x
    'haiku-4-5':  { input:  1.00, output:  5.00, cache5m:  1.25, cache1h:  2.00, cacheRead: 0.10 },
    // Legacy 3.x (just in case old JSONL files exist)
    'opus-3':     { input: 15.00, output: 75.00, cache5m: 18.75, cache1h: 30.00, cacheRead: 1.50 },
    'sonnet-3-5': { input:  3.00, output: 15.00, cache5m:  3.75, cache1h:  6.00, cacheRead: 0.30 },
    'sonnet-3-7': { input:  3.00, output: 15.00, cache5m:  3.75, cache1h:  6.00, cacheRead: 0.30 },
    'haiku-3-5':  { input:  0.80, output:  4.00, cache5m:  1.00, cache1h:  1.60, cacheRead: 0.08 },
    'haiku-3':    { input:  0.25, output:  1.25, cache5m:  0.30, cache1h:  0.50, cacheRead: 0.03 }
};

// Default fallback when model can't be matched — picks Opus (safer to overestimate than under)
const DEFAULT_MODEL_KEY = 'opus-4-7';

// 1M-context pricing tier: when single call's input (incl. cache) > 200K, all per-token components 2×
const CONTEXT_1M_THRESHOLD = 200000;
const CONTEXT_1M_MULTIPLIER = 2;

// Anthropic server-side tools (NOT subject to 1M tier doubling)
const WEB_SEARCH_COST = 0.01;  // $10 per 1000 requests

// Batch tier discount (rare — Claude Code interactive never uses batch)
const SERVICE_TIER_MULT = { standard: 1, priority: 1, batch: 0.5 };

// ─── Limits & config (overridden by calibration) ───
const LIMITS = {
    sessionCostLimit: 229,
    weeklyCostLimit: 5408,
    sessionWindowHours: 5,
    weeklyResetDay: 1,
    weeklyResetHourUTC: 17,
    sessionResetAt: null,
    sessionCycleAnchor: null,
    currentWindowStart: null,
    monthlySubCost: 200
};

const CALIBRATION_FILE = path.join(os.homedir(), '.claude', 'token-tracker-calibration.json');

// ─── State ───
/** @type {vscode.StatusBarItem} */ let statusBarItem;
/** @type {vscode.StatusBarItem} */ let costBarItem;
/** @type {vscode.StatusBarItem} */ let usageBarItem;
/** @type {vscode.OutputChannel} */ let outputChannel;
/** @type {fs.FSWatcher[]} */ let fileWatchers = [];
/** @type {NodeJS.Timeout|null} */ let refreshInterval = null;
/** @type {vscode.WebviewPanel|null} */ let dashboardPanel = null;
let notified80 = false;
let notified95 = false;

/** @type {Map<string, object>} */
let activeSessions = new Map();

// Aggregated totals across all active sessions
let sessionData = emptyAggregate();

// Window data (recalculated periodically)
let windowData = {
    session: emptyAggregate(),
    weekly: emptyAggregate(),
    lastCalculated: 0
};

let allTimeCostCache = { cost: 0, lastCalculated: 0 };

function emptyAggregate() {
    return {
        inputTokens: 0, outputTokens: 0,
        cache5mTokens: 0, cache1hTokens: 0, cacheReadTokens: 0,
        webSearches: 0,
        apiCalls: 0,
        cost: 0,
        modelBreakdown: {},
        sessionFile: '', sessionId: '', startTime: null, count: 0
    };
}

// ─────────────────────────────────────────────
// ACTIVATE
// ─────────────────────────────────────────────

function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Claude Token Tracker');
    loadCalibration();

    costBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
    costBarItem.command = 'claudeTokenTracker.showHistory';
    costBarItem.tooltip = 'API cost equivalent (klik za sve sesije)';
    context.subscriptions.push(costBarItem);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9999);
    statusBarItem.command = 'claudeTokenTracker.showDashboard';
    statusBarItem.tooltip = 'Tokeni aktivnih konverzacija (klik za dashboard)';
    context.subscriptions.push(statusBarItem);

    usageBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9998);
    usageBarItem.command = 'claudeTokenTracker.showDashboard';
    usageBarItem.tooltip = 'Klik za dashboard';
    context.subscriptions.push(usageBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('claudeTokenTracker.showDashboard', showDashboard),
        vscode.commands.registerCommand('claudeTokenTracker.showHistory', showAllSessions),
        vscode.commands.registerCommand('claudeTokenTracker.calibrate', calibrateUsage),
        vscode.commands.registerCommand('claudeTokenTracker.exportCsv', exportToCsv),
        vscode.commands.registerCommand('claudeTokenTracker.refresh', () => {
            findAndWatchSessions();
            recalculateWindows();
        })
    );

    findAndWatchSessions();
    recalculateWindows();

    refreshInterval = setInterval(() => {
        findAndWatchSessions();
        if (Date.now() - windowData.lastCalculated > 60000) {
            recalculateWindows();
        }
        if (dashboardPanel) {
            try { dashboardPanel.webview.html = buildDashboardHtml(); } catch (e) { /* panel disposed */ }
        }
    }, 10000);
    context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });

    updateStatusBar();
    outputChannel.appendLine('[Claude Token Tracker] Activated');
}

// ─────────────────────────────────────────────
// CALIBRATION
// ─────────────────────────────────────────────

function loadCalibration() {
    try {
        if (!fs.existsSync(CALIBRATION_FILE)) return;
        const data = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
        if (data.sessionCostLimit) LIMITS.sessionCostLimit = data.sessionCostLimit;
        if (data.weeklyCostLimit) LIMITS.weeklyCostLimit = data.weeklyCostLimit;
        if (data.monthlySubCost) LIMITS.monthlySubCost = data.monthlySubCost;
        if (data.weeklyResetHourUTC != null) LIMITS.weeklyResetHourUTC = data.weeklyResetHourUTC;
        if (data.weeklyResetDay != null) LIMITS.weeklyResetDay = data.weeklyResetDay;
        if (data.sessionCycleAnchor) {
            LIMITS.sessionCycleAnchor = new Date(data.sessionCycleAnchor);
            recalcSessionResetTime();
        }
        outputChannel.appendLine(`[Calibration] Loaded: session=$${LIMITS.sessionCostLimit}, weekly=$${LIMITS.weeklyCostLimit}, sub=$${LIMITS.monthlySubCost}/mj`);
    } catch (e) { /* use defaults */ }
}

function saveCalibration() {
    try {
        fs.writeFileSync(CALIBRATION_FILE, JSON.stringify({
            sessionCostLimit: LIMITS.sessionCostLimit,
            weeklyCostLimit: LIMITS.weeklyCostLimit,
            monthlySubCost: LIMITS.monthlySubCost,
            weeklyResetHourUTC: LIMITS.weeklyResetHourUTC,
            weeklyResetDay: LIMITS.weeklyResetDay,
            sessionCycleAnchor: LIMITS.sessionCycleAnchor ? LIMITS.sessionCycleAnchor.toISOString() : null,
            calibratedAt: new Date().toISOString()
        }, null, 2));
    } catch (e) {
        outputChannel.appendLine(`[Error] Save calibration: ${e.message}`);
    }
}

async function calibrateUsage() {
    const sessionPct = await vscode.window.showInputBox({
        title: 'Claude Kalibracija (1/4)',
        prompt: 'claude.ai/settings → Usage → Session % (npr. 13). Enter za preskočiti.',
        placeHolder: '13', ignoreFocusOut: true,
        validateInput: v => !v ? null : (parseFloat(v) >= 0 && parseFloat(v) <= 100 ? null : 'Broj 0-100')
    });
    if (sessionPct === undefined) return;

    const resetsIn = await vscode.window.showInputBox({
        title: 'Claude Kalibracija (2/4)',
        prompt: 'Session "Resets in" (npr. 4h15m, 4:15, ili 255 za minute). Enter za preskočiti.',
        placeHolder: '4h15m', ignoreFocusOut: true,
        validateInput: v => !v ? null : (parseResetTime(v) !== null ? null : 'Format: 4h15m, 4:15, ili 255')
    });
    if (resetsIn === undefined) return;

    const weeklyPct = await vscode.window.showInputBox({
        title: 'Claude Kalibracija (3/4)',
        prompt: 'Weekly % (npr. 45). Enter za preskočiti.',
        placeHolder: '45', ignoreFocusOut: true,
        validateInput: v => !v ? null : (parseFloat(v) >= 0 && parseFloat(v) <= 100 ? null : 'Broj 0-100')
    });
    if (weeklyPct === undefined) return;

    const subCost = await vscode.window.showInputBox({
        title: 'Claude Kalibracija (4/4)',
        prompt: 'Mjesečna cijena pretplate u $ (100 za Max, 200 za Max 5x). Enter za preskočiti.',
        placeHolder: String(LIMITS.monthlySubCost), ignoreFocusOut: true,
        validateInput: v => !v ? null : (parseFloat(v) > 0 ? null : 'Pozitivan broj')
    });
    if (subCost === undefined) return;

    if (resetsIn) {
        const resetMinutes = parseResetTime(resetsIn);
        if (resetMinutes !== null) {
            const nextReset = new Date(Date.now() + resetMinutes * 60000);
            LIMITS.sessionCycleAnchor = new Date(nextReset.getTime() - LIMITS.sessionWindowHours * 3600000);
            recalcSessionResetTime();
        }
    }

    recalculateWindows();

    if (sessionPct && parseFloat(sessionPct) > 0 && windowData.session.cost > 0) {
        LIMITS.sessionCostLimit = Math.round(windowData.session.cost / (parseFloat(sessionPct) / 100));
    }
    if (weeklyPct && parseFloat(weeklyPct) > 0 && windowData.weekly.cost > 0) {
        LIMITS.weeklyCostLimit = Math.round(windowData.weekly.cost / (parseFloat(weeklyPct) / 100));
    }
    if (subCost && parseFloat(subCost) > 0) {
        LIMITS.monthlySubCost = parseFloat(subCost);
    }

    saveCalibration();
    updateStatusBar();
    showDashboard();
}

function parseResetTime(input) {
    if (!input) return null;
    input = input.trim().toLowerCase();
    let m = input.match(/^(\d+)\s*h\s*(?:(\d+)\s*m(?:in)?)?$/);
    if (m) return parseInt(m[1]) * 60 + (parseInt(m[2]) || 0);
    m = input.match(/^(\d+):(\d+)$/);
    if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
    m = input.match(/^(\d+)\s*m?(?:in)?$/);
    if (m) { const n = parseInt(m[1]); return n <= 300 ? n : null; }
    return null;
}

// ─────────────────────────────────────────────
// SESSION RESET TIMING
// ─────────────────────────────────────────────

function recalcSessionResetTime() {
    if (!LIMITS.sessionCycleAnchor) return;
    const now = Date.now();
    const anchor = LIMITS.sessionCycleAnchor.getTime();
    const windowMs = LIMITS.sessionWindowHours * 3600000;
    const windowsPassed = Math.floor((now - anchor) / windowMs);
    LIMITS.currentWindowStart = new Date(anchor + windowsPassed * windowMs);
    LIMITS.sessionResetAt = new Date(LIMITS.currentWindowStart.getTime() + windowMs);
}

function getSessionWindowStart() {
    return LIMITS.currentWindowStart || new Date(Date.now() - LIMITS.sessionWindowHours * 3600000);
}

function getSessionResetIn() {
    if (!LIMITS.sessionResetAt) return null;
    const ms = LIMITS.sessionResetAt.getTime() - Date.now();
    if (ms <= 0) { recalcSessionResetTime(); return LIMITS.sessionResetAt ? LIMITS.sessionResetAt.getTime() - Date.now() : null; }
    return ms;
}

function getWeeklyResetIn() {
    const now = new Date();
    const daysSinceReset = (now.getUTCDay() - LIMITS.weeklyResetDay + 7) % 7;
    const nextReset = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceReset + 7,
        LIMITS.weeklyResetHourUTC, 0, 0
    ));
    return nextReset.getTime() - now.getTime();
}

function formatTimeRemaining(ms) {
    if (!ms || ms <= 0) return 'resetting...';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// ─────────────────────────────────────────────
// SESSION DISCOVERY
// ─────────────────────────────────────────────

function getClaudeDir() { return path.join(os.homedir(), '.claude'); }
function getProjectsDir() { return path.join(getClaudeDir(), 'projects'); }

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function findAndWatchSessions() {
    const sessionsDir = path.join(getClaudeDir(), 'sessions');
    const projectsDir = getProjectsDir();
    if (!fs.existsSync(sessionsDir) || !fs.existsSync(projectsDir)) return;

    const currentSessions = new Map();

    try {
        for (const file of fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
            try {
                const content = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'));
                if ((content.entrypoint === 'claude-vscode' || content.kind === 'interactive') && content.sessionId) {
                    const pid = content.pid || parseInt(file.replace('.json', ''));
                    if (pid && isProcessAlive(pid)) {
                        currentSessions.set(content.sessionId, content);
                    }
                }
            } catch (e) { /* skip */ }
        }
    } catch (e) { return; }

    if (currentSessions.size === 0) return;

    const hadSessions = activeSessions.size > 0;
    let newSessionFound = false;

    for (const [sid, session] of currentSessions) {
        if (activeSessions.has(sid)) continue;
        const jsonlFile = findJsonlForSession(projectsDir, sid);
        if (!jsonlFile) continue;

        const fresh = emptyAggregate();
        fresh.sessionFile = jsonlFile;
        fresh.sessionId = sid;
        fresh.startTime = session.startedAt ? new Date(session.startedAt) : new Date();
        fresh.pid = session.pid;
        activeSessions.set(sid, fresh);

        newSessionFound = true;
        outputChannel.appendLine(`[Session] Watching: ${sid} (PID ${session.pid}, ${activeSessions.size} active)`);

        try {
            const watcher = fs.watch(jsonlFile, { persistent: false }, () => {
                parseOneSession(sid);
                aggregateSessions();
            });
            watcher._sessionId = sid;
            fileWatchers.push(watcher);
        } catch (e) { /* skip */ }
    }

    for (const [sid] of activeSessions) {
        if (!currentSessions.has(sid)) {
            activeSessions.delete(sid);
            fileWatchers = fileWatchers.filter(w => { if (w._sessionId === sid) { w.close(); return false; } return true; });
            outputChannel.appendLine(`[Session] Removed: ${sid} (${activeSessions.size} active)`);
        }
    }

    if (newSessionFound && hadSessions) {
        vscode.window.showInformationMessage(
            `Nova Claude sesija (${activeSessions.size} aktivnih). Kalibrirati?`, 'Da', 'Ne'
        ).then(c => { if (c === 'Da') calibrateUsage(); });
    }

    for (const [sid] of activeSessions) parseOneSession(sid);
    aggregateSessions();
}

function findJsonlForSession(projectsDir, sessionId) {
    try {
        for (const project of fs.readdirSync(projectsDir)) {
            const projPath = path.join(projectsDir, project);
            if (!fs.statSync(projPath).isDirectory()) continue;
            for (const file of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'))) {
                const fullPath = path.join(projPath, file);
                try {
                    const fd = fs.openSync(fullPath, 'r');
                    const buf = Buffer.alloc(2048);
                    fs.readSync(fd, buf, 0, 2048, 0);
                    fs.closeSync(fd);
                    if (buf.toString('utf8').includes(sessionId)) return fullPath;
                } catch (e) { /* skip */ }
            }
        }
    } catch (e) { /* skip */ }
    return null;
}

// ─────────────────────────────────────────────
// MODEL DETECTION + COST CALCULATION
// ─────────────────────────────────────────────

function getModelKey(model) {
    if (!model || typeof model !== 'string') return DEFAULT_MODEL_KEY;
    // Strip "claude-" prefix, "-YYYYMMDD" date suffix, "[1m]" or similar bracket tags
    const stripped = model
        .replace(/^claude-/, '')
        .replace(/-\d{6,8}$/, '')
        .replace(/\[[^\]]*\]$/, '');
    if (MODEL_PRICING[stripped]) return stripped;
    // Progressive prefix match (e.g. "opus-4-7-foo" → tries "opus-4-7", "opus-4", "opus")
    const parts = stripped.split('-');
    for (let i = parts.length; i > 0; i--) {
        const key = parts.slice(0, i).join('-');
        if (MODEL_PRICING[key]) return key;
    }
    return DEFAULT_MODEL_KEY;
}

/**
 * Compute cost for a single assistant message's usage block.
 * Handles: per-model pricing, 5m vs 1h cache TTL, 1M context tier doubling,
 *          web search add-on, batch tier discount.
 */
function computeUsageCost(usage, model) {
    if (!usage) return { cost: 0, tokens: empty5(), webSearches: 0, modelKey: DEFAULT_MODEL_KEY };
    const key = getModelKey(model);
    const p = MODEL_PRICING[key];

    const inputT = usage.input_tokens || 0;
    const outputT = usage.output_tokens || 0;

    // Cache write breakdown — prefer ephemeral_{5m,1h} sub-fields; fall back to flat field as 5m
    const cc = usage.cache_creation || {};
    let cache5m = cc.ephemeral_5m_input_tokens || 0;
    let cache1h = cc.ephemeral_1h_input_tokens || 0;
    if (cache5m === 0 && cache1h === 0 && (usage.cache_creation_input_tokens || 0) > 0) {
        cache5m = usage.cache_creation_input_tokens;
    }
    const cacheRead = usage.cache_read_input_tokens || 0;

    // 1M context tier: when total input on this call > 200K, Anthropic doubles all per-token components
    const totalInputThisCall = inputT + cache5m + cache1h + cacheRead;
    const ctxMult = totalInputThisCall > CONTEXT_1M_THRESHOLD ? CONTEXT_1M_MULTIPLIER : 1;

    // Service tier (interactive Claude Code = standard)
    const tierMult = SERVICE_TIER_MULT[usage.service_tier] || 1;
    const mult = ctxMult * tierMult;

    const tokenCost = mult * (
        (inputT     / 1e6) * p.input +
        (outputT    / 1e6) * p.output +
        (cache5m    / 1e6) * p.cache5m +
        (cache1h    / 1e6) * p.cache1h +
        (cacheRead  / 1e6) * p.cacheRead
    );

    // Server-side tools (web search) — billed separately, NOT subject to 1M doubling
    const webSearches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
    const webCost = webSearches * WEB_SEARCH_COST;

    return {
        cost: tokenCost + webCost,
        tokens: { input: inputT, output: outputT, cache5m, cache1h, cacheRead },
        webSearches,
        modelKey: key
    };
}

function empty5() { return { input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0 }; }

// ─────────────────────────────────────────────
// JSONL PARSING
// ─────────────────────────────────────────────

function parseOneSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (!session || !session.sessionFile || !fs.existsSync(session.sessionFile)) return;
    try {
        resetAggregate(session);
        parseFileInto(session.sessionFile, session);
        const subDir = path.join(session.sessionFile.replace('.jsonl', ''), 'subagents');
        if (fs.existsSync(subDir)) {
            for (const sf of fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) {
                parseFileInto(path.join(subDir, sf), session);
            }
        }
    } catch (e) {
        outputChannel.appendLine(`[Error] Parse ${sessionId}: ${e.message}`);
    }
}

function parseFileInto(filePath, target) {
    try {
        for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const e = JSON.parse(line);
                if (e.type === 'assistant' && e.message && e.message.usage) {
                    accumulateCall(target, e.message.usage, e.message.model);
                }
            } catch (e) { /* skip */ }
        }
    } catch (e) { /* skip */ }
}

function resetAggregate(t) {
    t.inputTokens = 0; t.outputTokens = 0;
    t.cache5mTokens = 0; t.cache1hTokens = 0; t.cacheReadTokens = 0;
    t.webSearches = 0; t.apiCalls = 0; t.cost = 0;
    t.modelBreakdown = {};
}

function accumulateCall(target, usage, model) {
    const r = computeUsageCost(usage, model);
    target.inputTokens     += r.tokens.input;
    target.outputTokens    += r.tokens.output;
    target.cache5mTokens   += r.tokens.cache5m;
    target.cache1hTokens   += r.tokens.cache1h;
    target.cacheReadTokens += r.tokens.cacheRead;
    target.webSearches     += r.webSearches;
    target.cost            += r.cost;
    target.apiCalls++;

    const mb = target.modelBreakdown[r.modelKey] || (target.modelBreakdown[r.modelKey] = {
        input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0, webSearches: 0, calls: 0, cost: 0
    });
    mb.input      += r.tokens.input;
    mb.output     += r.tokens.output;
    mb.cache5m    += r.tokens.cache5m;
    mb.cache1h    += r.tokens.cache1h;
    mb.cacheRead  += r.tokens.cacheRead;
    mb.webSearches+= r.webSearches;
    mb.cost       += r.cost;
    mb.calls++;
}

function aggregateSessions() {
    let earliest = null;
    resetAggregate(sessionData);
    sessionData.count = activeSessions.size;

    for (const [sid, s] of activeSessions) {
        sessionData.inputTokens     += s.inputTokens;
        sessionData.outputTokens    += s.outputTokens;
        sessionData.cache5mTokens   += s.cache5mTokens;
        sessionData.cache1hTokens   += s.cache1hTokens;
        sessionData.cacheReadTokens += s.cacheReadTokens;
        sessionData.webSearches     += s.webSearches;
        sessionData.cost            += s.cost;
        sessionData.apiCalls        += s.apiCalls;
        sessionData.sessionId = sid;
        sessionData.sessionFile = s.sessionFile;

        for (const [k, mb] of Object.entries(s.modelBreakdown)) {
            const dst = sessionData.modelBreakdown[k] || (sessionData.modelBreakdown[k] = {
                input: 0, output: 0, cache5m: 0, cache1h: 0, cacheRead: 0, webSearches: 0, calls: 0, cost: 0
            });
            dst.input += mb.input; dst.output += mb.output;
            dst.cache5m += mb.cache5m; dst.cache1h += mb.cache1h; dst.cacheRead += mb.cacheRead;
            dst.webSearches += mb.webSearches; dst.cost += mb.cost; dst.calls += mb.calls;
        }

        if (!earliest || (s.startTime && s.startTime < earliest)) earliest = s.startTime;
    }
    sessionData.startTime = earliest;
    updateStatusBar();
}

// ─────────────────────────────────────────────
// WINDOW CALCULATIONS
// ─────────────────────────────────────────────

function recalculateWindows() {
    const projectsDir = getProjectsDir();
    if (!fs.existsSync(projectsDir)) return;

    recalcSessionResetTime();
    const sessionWindowStart = getSessionWindowStart();
    const now = new Date();

    const daysSinceReset = (now.getUTCDay() - LIMITS.weeklyResetDay + 7) % 7;
    const weekStart = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceReset,
        LIMITS.weeklyResetHourUTC, 0, 0
    ));
    if (weekStart > now) weekStart.setDate(weekStart.getDate() - 7);

    const session = emptyAggregate();
    const weekly = emptyAggregate();

    try {
        for (const jsonlPath of getAllJsonlFiles(projectsDir)) {
            try {
                for (const line of fs.readFileSync(jsonlPath, 'utf8').split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const entry = JSON.parse(line);
                        if (entry.type !== 'assistant' || !entry.message || !entry.message.usage) continue;
                        const ts = entry.timestamp ? new Date(entry.timestamp) : null;
                        if (!ts) continue;
                        if (ts >= weekStart) accumulateCall(weekly, entry.message.usage, entry.message.model);
                        if (ts >= sessionWindowStart) accumulateCall(session, entry.message.usage, entry.message.model);
                    } catch (e) { /* skip */ }
                }
            } catch (e) { /* skip */ }
        }
    } catch (e) { /* skip */ }

    windowData.session = session;
    windowData.weekly = weekly;
    windowData.lastCalculated = Date.now();

    const sessionPct = LIMITS.sessionCostLimit > 0 ? (session.cost / LIMITS.sessionCostLimit) * 100 : 0;
    if (sessionPct >= 95 && !notified95) {
        notified95 = true;
        vscode.window.showWarningMessage(`Claude session usage ~${Math.round(sessionPct)}%! Blizu rate limita.`);
    } else if (sessionPct >= 80 && !notified80) {
        notified80 = true;
        vscode.window.showInformationMessage(`Claude session usage ~${Math.round(sessionPct)}%. Pazi na potrošnju.`);
    }
    if (sessionPct < 10) { notified80 = false; notified95 = false; }

    updateStatusBar();
}

function getAllJsonlFiles(projectsDir) {
    const files = [];
    try {
        for (const project of fs.readdirSync(projectsDir)) {
            const projPath = path.join(projectsDir, project);
            if (!fs.statSync(projPath).isDirectory()) continue;
            for (const file of fs.readdirSync(projPath)) {
                if (file.endsWith('.jsonl')) {
                    files.push(path.join(projPath, file));
                    const subDir = path.join(projPath, file.replace('.jsonl', ''), 'subagents');
                    if (fs.existsSync(subDir)) {
                        for (const sf of fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) {
                            files.push(path.join(subDir, sf));
                        }
                    }
                }
            }
        }
    } catch (e) { /* skip */ }
    return files;
}

// ─────────────────────────────────────────────
// DERIVED HELPERS
// ─────────────────────────────────────────────

function totalInputDisplayTokens(agg) {
    return agg.inputTokens + agg.cache5mTokens + agg.cache1hTokens + agg.cacheReadTokens;
}

function totalTokens(agg) {
    return agg.inputTokens + agg.outputTokens + agg.cache5mTokens + agg.cache1hTokens + agg.cacheReadTokens;
}

function dominantModel(agg) {
    let bestKey = null, bestCalls = 0;
    for (const [k, mb] of Object.entries(agg.modelBreakdown || {})) {
        if (mb.calls > bestCalls) { bestCalls = mb.calls; bestKey = k; }
    }
    return bestKey;
}

function getAllTimeCost() {
    if (Date.now() - allTimeCostCache.lastCalculated < 300000 && allTimeCostCache.cost > 0) {
        return allTimeCostCache.cost;
    }
    const projectsDir = getProjectsDir();
    if (!fs.existsSync(projectsDir)) return 0;
    let total = 0;
    try {
        for (const jsonl of getAllJsonlFiles(projectsDir)) {
            try {
                for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const e = JSON.parse(line);
                        if (e.type === 'assistant' && e.message && e.message.usage) {
                            total += computeUsageCost(e.message.usage, e.message.model).cost;
                        }
                    } catch (e) { /* skip */ }
                }
            } catch (e) { /* skip */ }
        }
    } catch (e) { /* skip */ }
    allTimeCostCache.cost = total;
    allTimeCostCache.lastCalculated = Date.now();
    return total;
}

function fmt(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
}

// ─────────────────────────────────────────────
// STATUS BAR
// ─────────────────────────────────────────────

function updateStatusBar() {
    const totalIn = totalInputDisplayTokens(sessionData);

    const countLabel = sessionData.count > 1 ? ` (${sessionData.count})` : '';
    statusBarItem.text = sessionData.apiCalls === 0
        ? `$(pulse) Claude: waiting...`
        : `$(pulse) ${fmt(totalIn)} in / ${fmt(sessionData.outputTokens)} out${countLabel}`;

    costBarItem.text = `$(credit-card) $${sessionData.cost.toFixed(2)}`;

    const sPct = LIMITS.sessionCostLimit > 0 ? Math.min(100, (windowData.session.cost / LIMITS.sessionCostLimit) * 100) : 0;
    const wPct = LIMITS.weeklyCostLimit > 0 ? Math.min(100, (windowData.weekly.cost / LIMITS.weeklyCostLimit) * 100) : 0;
    const resetMs = getSessionResetIn();
    const resetText = resetMs ? ` | ${formatTimeRemaining(resetMs)}` : '';
    let rateText = '';
    if (sessionData.startTime && sessionData.apiCalls > 0) {
        const min = (Date.now() - sessionData.startTime.getTime()) / 60000;
        if (min > 0.5) rateText = ` | ${fmt(Math.round((totalIn + sessionData.outputTokens) / min))}/min`;
    }

    const warn = sPct >= 80 ? '$(warning) ' : '';
    usageBarItem.text = `${warn}$(graph) S:${Math.round(sPct)}% W:${Math.round(wPct)}%${resetText}${rateText}`;

    const sRem = Math.max(0, LIMITS.sessionCostLimit - windowData.session.cost);
    const wRem = Math.max(0, LIMITS.weeklyCostLimit - windowData.weekly.cost);
    const resetInfo = LIMITS.sessionResetAt
        ? `Session reset: ${LIMITS.sessionResetAt.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' })} (za ${formatTimeRemaining(resetMs)})`
        : 'Session reset: nepoznat (kalibriraj)';
    const dom = dominantModel(sessionData);
    usageBarItem.tooltip = [
        `Session: ~${Math.round(sPct)}% ($${windowData.session.cost.toFixed(0)} / $${LIMITS.sessionCostLimit})`,
        `Weekly: ~${Math.round(wPct)}% ($${windowData.weekly.cost.toFixed(0)} / $${LIMITS.weeklyCostLimit})`,
        resetInfo,
        `Preostalo: session ~$${sRem.toFixed(0)}, weekly ~$${wRem.toFixed(0)}`,
        `Aktivnih sesija: ${activeSessions.size}${dom ? ' | dominant model: ' + dom : ''}`,
        '', 'Klik za dashboard'
    ].join('\n');

    if (sPct >= 95) usageBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    else if (sPct >= 80) usageBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    else usageBarItem.backgroundColor = undefined;

    statusBarItem.show(); costBarItem.show(); usageBarItem.show();
}

// ─────────────────────────────────────────────
// DASHBOARD (auto-refreshing)
// ─────────────────────────────────────────────

function showDashboard() {
    if (dashboardPanel) {
        dashboardPanel.reveal();
        dashboardPanel.webview.html = buildDashboardHtml();
        return;
    }
    dashboardPanel = vscode.window.createWebviewPanel(
        'claudeDashboard', 'Claude Usage Dashboard', vscode.ViewColumn.One, { enableScripts: false }
    );
    dashboardPanel.webview.html = buildDashboardHtml();
    dashboardPanel.onDidDispose(() => { dashboardPanel = null; });
}

function buildDashboardHtml() {
    recalculateWindows();
    const sPct = LIMITS.sessionCostLimit > 0 ? Math.min(100, (windowData.session.cost / LIMITS.sessionCostLimit) * 100) : 0;
    const wPct = LIMITS.weeklyCostLimit > 0 ? Math.min(100, (windowData.weekly.cost / LIMITS.weeklyCostLimit) * 100) : 0;
    const totalConvTokens = totalTokens(sessionData);

    let tokPerMin = 0, costPerHour = 0;
    if (sessionData.startTime && sessionData.apiCalls > 0) {
        const min = (Date.now() - sessionData.startTime.getTime()) / 60000;
        if (min > 0.5) {
            tokPerMin = totalConvTokens / min;
            costPerHour = (sessionData.cost / min) * 60;
        }
    }

    const sRemCost = Math.max(0, LIMITS.sessionCostLimit - windowData.session.cost);
    const wRemCost = Math.max(0, LIMITS.weeklyCostLimit - windowData.weekly.cost);
    const resetMs = getSessionResetIn();
    const resetTimeStr = LIMITS.sessionResetAt ? LIMITS.sessionResetAt.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' }) : '?';
    const resetCountdown = resetMs ? formatTimeRemaining(resetMs) : 'kalibriraj';
    const wResetMs = getWeeklyResetIn();

    let estTimeToLimit = 'N/A';
    if (costPerHour > 0) {
        const h = sRemCost / costPerHour;
        estTimeToLimit = h < 1 ? `~${Math.round(h * 60)} min` : `~${h.toFixed(1)}h`;
    }

    const allTimeCost = getAllTimeCost();
    const totalSaved = allTimeCost - LIMITS.monthlySubCost;

    // Per-session rows
    const sessionRows = Array.from(activeSessions.values()).map((s, i) => {
        const tIn = totalInputDisplayTokens(s);
        return `<tr><td>#${i + 1} (${s.sessionId.substring(0, 8)}…) PID:${s.pid || '?'}</td><td class="n">${s.apiCalls}</td><td class="n">${fmt(tIn)}</td><td class="n">${fmt(s.outputTokens)}</td><td class="n g">$${s.cost.toFixed(2)}</td></tr>`;
    }).join('');

    const totalRow = activeSessions.size > 1
        ? `<tr class="total"><td>UKUPNO</td><td class="n">${sessionData.apiCalls}</td><td class="n">${fmt(totalInputDisplayTokens(sessionData))}</td><td class="n">${fmt(sessionData.outputTokens)}</td><td class="n g">$${sessionData.cost.toFixed(2)}</td></tr>`
        : '';

    // Per-model breakdown rows
    const modelRows = Object.entries(sessionData.modelBreakdown)
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([k, mb]) => `<tr><td>${k}</td><td class="n">${mb.calls}</td><td class="n">${fmt(mb.input + mb.cache5m + mb.cache1h + mb.cacheRead)}</td><td class="n">${fmt(mb.output)}</td><td class="n g">$${mb.cost.toFixed(2)}</td></tr>`)
        .join('') || '<tr><td colspan="5" class="cs">(nema aktivnih poziva)</td></tr>';

    const webSearchRow = sessionData.webSearches > 0
        ? `<tr><td>Web search</td><td class="n">${sessionData.webSearches}</td><td class="n g">$${(sessionData.webSearches * WEB_SEARCH_COST).toFixed(4)}</td></tr>`
        : '';

    const pBar = (pct, label1, label2) => `
        <div class="pb"><div class="pf ${pct >= 80 ? 'hi' : pct >= 50 ? 'mi' : 'lo'}" style="width:${Math.min(100, pct)}%"></div></div>
        <div class="pl"><span>${label1}</span><span>${label2}</span></div>`;

    const dom = dominantModel(sessionData) || 'auto';

    return `<!DOCTYPE html><html><head><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:900px;margin:0 auto}
h1{font-size:1.5em;margin-bottom:4px}h2{font-size:1.05em;color:var(--vscode-descriptionForeground);margin-top:24px;margin-bottom:8px}
.sub{color:var(--vscode-descriptionForeground);font-size:.85em;margin-bottom:20px}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
.card{padding:14px 18px;border:1px solid var(--vscode-widget-border);border-radius:8px}
.cl{font-size:.75em;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:.5px}
.cv{font-size:1.8em;font-weight:700;margin:2px 0;font-variant-numeric:tabular-nums}
.cs{font-size:.8em;color:var(--vscode-descriptionForeground)}
.g{color:var(--vscode-charts-green)}.y{color:var(--vscode-charts-yellow)}.r{color:var(--vscode-charts-red)}.b{color:var(--vscode-charts-blue)}
.pb{height:10px;background:var(--vscode-widget-border);border-radius:5px;overflow:hidden;margin:6px 0 2px}
.pf{height:100%;border-radius:5px}.lo{background:var(--vscode-charts-blue)}.mi{background:var(--vscode-charts-yellow)}.hi{background:var(--vscode-charts-red)}
.pl{display:flex;justify-content:space-between;font-size:.75em;color:var(--vscode-descriptionForeground)}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{padding:5px 12px;text-align:left;border-bottom:1px solid var(--vscode-widget-border)}
th{color:var(--vscode-descriptionForeground);font-weight:600;font-size:.8em}.n{text-align:right;font-variant-numeric:tabular-nums}
.total{font-weight:700;border-top:2px solid var(--vscode-focusBorder)}
.sav{padding:14px;border:2px solid var(--vscode-charts-green);border-radius:8px;margin:14px 0;text-align:center}
.sav .big{font-size:2em;font-weight:700;color:var(--vscode-charts-green)}
.note{font-size:.75em;color:var(--vscode-descriptionForeground);margin-top:14px;padding:8px;border-left:3px solid var(--vscode-focusBorder)}
</style></head><body>
<h1>Claude Usage Dashboard</h1>
<div class="sub">Max ($${LIMITS.monthlySubCost}/mj) | dominant: ${dom} | ${new Date().toLocaleTimeString('hr-HR')} | Auto-refresh 10s</div>

<h2>Session (5h) — Reset: ${resetTimeStr} (za ${resetCountdown})</h2>
${pBar(sPct, `${Math.round(sPct)}% (~$${windowData.session.cost.toFixed(2)})`, `~$${sRemCost.toFixed(2)} preostalo | Do limita: ${estTimeToLimit}`)}

<h2>Weekly — Reset: za ${formatTimeRemaining(wResetMs)}</h2>
${pBar(wPct, `${Math.round(wPct)}% (~$${windowData.weekly.cost.toFixed(2)})`, `~$${wRemCost.toFixed(2)} preostalo`)}

<div class="cards">
    <div class="card"><div class="cl">Aktivne konverzacije (${activeSessions.size})</div><div class="cv b">${fmt(totalConvTokens)}</div><div class="cs">${sessionData.apiCalls} calls | $${sessionData.cost.toFixed(2)}</div></div>
    <div class="card"><div class="cl">Brzina</div><div class="cv ${costPerHour > 100 ? 'r' : costPerHour > 50 ? 'y' : 'g'}">${tokPerMin > 0 ? fmt(Math.round(tokPerMin)) + '/min' : 'N/A'}</div><div class="cs">${costPerHour > 0 ? '$' + costPerHour.toFixed(2) + '/h' : ''}</div></div>
    <div class="card"><div class="cl">Session window</div><div class="cv">${fmt(totalTokens(windowData.session))}</div><div class="cs">${windowData.session.apiCalls} calls | $${windowData.session.cost.toFixed(2)}</div></div>
    <div class="card"><div class="cl">Weekly</div><div class="cv">${fmt(totalTokens(windowData.weekly))}</div><div class="cs">${windowData.weekly.apiCalls} calls | $${windowData.weekly.cost.toFixed(2)}</div></div>
</div>

<h2>Per-session breakdown</h2>
<table><tr><th>Sesija</th><th class="n">Calls</th><th class="n">Input</th><th class="n">Output</th><th class="n">Cost</th></tr>
${sessionRows}${totalRow}</table>

<h2>Per-model breakdown (current sessions)</h2>
<table><tr><th>Model</th><th class="n">Calls</th><th class="n">Input</th><th class="n">Output</th><th class="n">Cost</th></tr>
${modelRows}</table>

<h2>Token types</h2>
<table><tr><th>Tip</th><th class="n">Tokeni</th><th class="n">Cost (procjena)</th></tr>
<tr><td>Input (uncached)</td><td class="n">${sessionData.inputTokens.toLocaleString()}</td><td class="n cs">vidi per-model</td></tr>
<tr><td>Output</td><td class="n">${sessionData.outputTokens.toLocaleString()}</td><td class="n cs">vidi per-model</td></tr>
<tr><td>Cache write (5m)</td><td class="n">${sessionData.cache5mTokens.toLocaleString()}</td><td class="n cs">vidi per-model</td></tr>
<tr><td>Cache write (1h)</td><td class="n">${sessionData.cache1hTokens.toLocaleString()}</td><td class="n cs">2× cijena 5m</td></tr>
<tr><td>Cache read</td><td class="n">${sessionData.cacheReadTokens.toLocaleString()}</td><td class="n cs">~10% cijene inputa</td></tr>
${webSearchRow}</table>

<div class="sav"><div>Uštedjeno vs API</div><div class="big">$${totalSaved > 0 ? totalSaved.toFixed(0) : '0'}</div>
<div class="cs">API ekv: $${allTimeCost.toFixed(2)} | Sub: $${LIMITS.monthlySubCost}/mj</div></div>

<div class="note">Per-model pricing (Opus/Sonnet/Haiku 4.x + legacy 3.x), 5m vs 1h cache razlika, 1M context tier 2× detekcija (>200K tokena po pozivu), web_search billing ($10/1000). <b>Ctrl+Shift+P → Claude Tokens: Calibrate</b> za session/weekly % limit.</div>
</body></html>`;
}

// ─────────────────────────────────────────────
// ALL SESSIONS
// ─────────────────────────────────────────────

function showAllSessions() {
    const projectsDir = getProjectsDir();
    if (!fs.existsSync(projectsDir)) { vscode.window.showInformationMessage('Nema sesija.'); return; }

    const sessions = [];
    try {
        for (const project of fs.readdirSync(projectsDir)) {
            const projPath = path.join(projectsDir, project);
            if (!fs.statSync(projPath).isDirectory()) continue;
            for (const file of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'))) {
                const fullPath = path.join(projPath, file);
                const stat = fs.statSync(fullPath);
                const data = parseJsonlFileFull(fullPath);
                if (data.apiCalls > 0) sessions.push({ project, file: file.replace('.jsonl', ''), date: stat.mtime, ...data });
            }
        }
    } catch (e) { /* skip */ }

    sessions.sort((a, b) => b.date - a.date);

    const dailyTotals = new Map();
    let totalAllCost = 0, totalAllTokens = 0;
    let rows = '';

    for (const s of sessions) {
        totalAllCost += s.cost;
        const tokens = totalTokens(s);
        totalAllTokens += tokens;

        const dayKey = s.date.toLocaleDateString('hr-HR');
        if (!dailyTotals.has(dayKey)) dailyTotals.set(dayKey, { cost: 0, tokens: 0, calls: 0, sessions: 0 });
        const day = dailyTotals.get(dayKey);
        day.cost += s.cost; day.tokens += tokens; day.calls += s.apiCalls; day.sessions++;

        const dateStr = dayKey + ' ' + s.date.toLocaleTimeString('hr-HR', { hour: '2-digit', minute: '2-digit' });
        const hl = s.file === sessionData.sessionId ? ' class="hl"' : '';
        const dom = dominantModel(s) || '?';
        rows += `<tr${hl}><td>${dateStr}</td><td>${s.project.replace(/^c--/, '').replace(/-/g, '/')}</td><td>${dom}</td><td class="n">${s.apiCalls}</td><td class="n">${fmt(totalInputDisplayTokens(s))}</td><td class="n">${fmt(s.outputTokens)}</td><td class="n g">$${s.cost.toFixed(2)}</td></tr>`;
    }

    let dailyRows = '';
    for (const [day, d] of dailyTotals) {
        dailyRows += `<tr><td>${day}</td><td class="n">${d.sessions}</td><td class="n">${d.calls}</td><td class="n">${fmt(d.tokens)}</td><td class="n g">$${d.cost.toFixed(2)}</td></tr>`;
    }

    const panel = vscode.window.createWebviewPanel('claudeTokenHistory', 'Claude - All Sessions', vscode.ViewColumn.One, {});
    panel.webview.html = `<!DOCTYPE html><html><head><style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px}
h1{font-size:1.4em}h2{font-size:1.1em;color:var(--vscode-descriptionForeground);margin-top:24px}
.sum{font-size:1.1em;margin:12px 0;padding:12px;border:1px solid var(--vscode-widget-border);border-radius:6px}
.big{font-size:1.8em;font-weight:700}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{padding:5px 10px;text-align:left;border-bottom:1px solid var(--vscode-widget-border)}
th{color:var(--vscode-descriptionForeground);font-weight:600;position:sticky;top:0;background:var(--vscode-editor-background)}
.n{text-align:right;font-variant-numeric:tabular-nums}.g{color:var(--vscode-charts-green)}.hl{background:var(--vscode-editor-selectionBackground)}
</style></head><body>
<h1>Claude Token Usage</h1>
<div class="sum"><span class="big g">$${totalAllCost.toFixed(2)}</span> ukupno | ${fmt(totalAllTokens)} tokena | ${sessions.length} sesija</div>

<h2>Po danima</h2>
<table><tr><th>Dan</th><th class="n">Sesija</th><th class="n">Calls</th><th class="n">Tokeni</th><th class="n">Cost</th></tr>${dailyRows}</table>

<h2>Sve sesije</h2>
<table><tr><th>Datum</th><th>Projekt</th><th>Model</th><th class="n">Calls</th><th class="n">Input</th><th class="n">Output</th><th class="n">Cost</th></tr>${rows}</table>
</body></html>`;
}

// ─────────────────────────────────────────────
// EXPORT CSV
// ─────────────────────────────────────────────

async function exportToCsv() {
    const projectsDir = getProjectsDir();
    if (!fs.existsSync(projectsDir)) return;
    const sessions = [];
    try {
        for (const project of fs.readdirSync(projectsDir)) {
            const projPath = path.join(projectsDir, project);
            if (!fs.statSync(projPath).isDirectory()) continue;
            for (const file of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl'))) {
                const stat = fs.statSync(path.join(projPath, file));
                const data = parseJsonlFileFull(path.join(projPath, file));
                if (data.apiCalls > 0) {
                    const dom = dominantModel(data) || '?';
                    sessions.push([
                        stat.mtime.toISOString(),
                        project.replace(/^c--/, '').replace(/-/g, '/'),
                        file.replace('.jsonl', ''),
                        dom,
                        data.apiCalls,
                        data.inputTokens,
                        data.outputTokens,
                        data.cache5mTokens,
                        data.cache1hTokens,
                        data.cacheReadTokens,
                        data.webSearches,
                        totalTokens(data),
                        data.cost.toFixed(4)
                    ].join(','));
                }
            }
        }
    } catch (e) { /* skip */ }

    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'claude-usage-export.csv')),
        filters: { 'CSV': ['csv'] }
    });
    if (uri) {
        const header = 'Date,Project,SessionId,DominantModel,ApiCalls,Input,Output,Cache5m,Cache1h,CacheRead,WebSearches,TotalTokens,ApiCost\n';
        fs.writeFileSync(uri.fsPath, header + sessions.join('\n'), 'utf8');
        vscode.window.showInformationMessage(`Exportano ${sessions.length} sesija u ${uri.fsPath}`);
    }
}

// ─── Parse helper for historic files ───
function parseJsonlFileFull(filePath) {
    const agg = emptyAggregate();
    try {
        for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { const e = JSON.parse(line); if (e.type === 'assistant' && e.message && e.message.usage) accumulateCall(agg, e.message.usage, e.message.model); } catch (e) { /* skip */ }
        }
        const subDir = path.join(filePath.replace('.jsonl', ''), 'subagents');
        if (fs.existsSync(subDir)) {
            for (const sf of fs.readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) {
                for (const line of fs.readFileSync(path.join(subDir, sf), 'utf8').split('\n')) {
                    if (!line.trim()) continue;
                    try { const e = JSON.parse(line); if (e.type === 'assistant' && e.message && e.message.usage) accumulateCall(agg, e.message.usage, e.message.model); } catch (e) { /* skip */ }
                }
            }
        }
    } catch (e) { /* skip */ }
    return agg;
}

// ─── Deactivate ───
function deactivate() {
    for (const w of fileWatchers) { try { w.close(); } catch (e) { /* ok */ } }
    fileWatchers = [];
    activeSessions.clear();
    if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
    dashboardPanel = null;
}

module.exports = { activate, deactivate };
