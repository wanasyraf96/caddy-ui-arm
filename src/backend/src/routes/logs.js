import { Router } from 'express';
import { readContainerFile } from '../containerFs.js';
import { execInInstance, spawnInInstance } from '../docker.js';
import logger, { getRecentLogEntries, subscribeToLogs } from '../logger.js';
import { AppError, asAppError } from '../AppError.js';
import { sendAppError } from '../errorReporting.js';
import { historyWarning, saveCaddyfileChange, validateCaddyfile } from './caddyfile.js';
import { getAuthentication } from '../middleware/auth.js';
const router = Router();
const appLogsRouter = Router();
const TAIL_LINES = 200;

// ── Log config parsing ────────────────────────────────────────────────────────

function extractGlobalBlock(content) {
    const lines = content.split('\n');
    let startIdx = -1;
    let endIdx = -1;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (startIdx === -1 && trimmed === '{') {
            startIdx = i;
            depth = 1;
            continue;
        }
        if (startIdx !== -1 && endIdx === -1) {
            for (const ch of lines[i]) {
                if (ch === '{') depth++;
                if (ch === '}') depth--;
            }
            if (depth === 0) {
                endIdx = i;
                break;
            }
        }
    }

    if (startIdx === -1) return null;
    return {
        text: lines.slice(startIdx, endIdx + 1).join('\n'),
        inner: lines.slice(startIdx + 1, endIdx).join('\n'),
        startIdx,
        endIdx,
    };
}

function extractDirectiveBlock(text, directive) {
    const pattern = new RegExp(`(^|\\n)([ \\t]*)${directive}\\s*\\{`, 'm');
    const match = text.match(pattern);
    if (!match) return null;

    const blockStart = match.index + match[0].length;
    let depth = 1;
    let i = blockStart;
    while (i < text.length && depth > 0) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        i++;
    }

    const fullStart = match.index + match[1].length;
    return {
        fullMatch: text.slice(fullStart, i),
        inner: text.slice(blockStart, i - 1),
        start: fullStart,
        end: i,
    };
}

function parseLogConfig(content) {
    const defaultConfig = {
        enabled: false,
        path: '/var/log/caddy/access.log',
        rollSize: '50mb',
        rollKeep: 5,
        format: 'json',
        level: 'INFO',
    };

    const global = extractGlobalBlock(content);
    if (!global) return defaultConfig;

    const log = extractDirectiveBlock(global.inner, 'log');
    if (!log) return defaultConfig;

    const logBlock = log.inner;
    const config = { ...defaultConfig, enabled: true };

    const fileMatch = logBlock.match(/output\s+file\s+(\S+)/);
    if (fileMatch) config.path = fileMatch[1];

    const rollSizeMatch = logBlock.match(/roll_size\s+(\S+)/);
    if (rollSizeMatch) config.rollSize = rollSizeMatch[1];

    const rollKeepMatch = logBlock.match(/roll_keep\s+(\d+)/);
    if (rollKeepMatch) config.rollKeep = parseInt(rollKeepMatch[1]);

    const formatMatch = logBlock.match(/format\s+(\S+)/);
    if (formatMatch) config.format = formatMatch[1];

    const levelMatch = logBlock.match(/level\s+(\S+)/);
    if (levelMatch) config.level = levelMatch[1].toUpperCase();

    return config;
}

function buildLogBlock(config) {
    if (!config.enabled) return null;

    return `\tlog {
\t\toutput file ${config.path} {
\t\t\troll_size ${config.rollSize}
\t\t\troll_keep ${config.rollKeep}
\t\t}
\t\tformat ${config.format}
\t\tlevel ${config.level}
\t}`;
}

function updateGlobalBlock(content, logConfig) {
    const logBlock = buildLogBlock(logConfig);
    const global = extractGlobalBlock(content);

    if (!global) {
        if (!logBlock) return content;
        return `{\n${logBlock}\n}\n\n${content.trim()}\n`;
    }

    let inner = global.inner;
    const log = extractDirectiveBlock(inner, 'log');
    if (log) {
        inner = inner.slice(0, log.start) + inner.slice(log.end);
    }

    const newInner = logBlock
        ? `${inner.trimEnd()}\n${logBlock}`
        : inner.trimEnd();

    const newGlobal = `{\n${newInner}\n}`;
    return content.replace(global.text, newGlobal);
}

// ── Routes ────────────────────────────────────────────────────────────────────

appLogsRouter.get('/', (req, res) => {
    res.json({ entries: getRecentLogEntries(TAIL_LINES) });
});

appLogsRouter.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const unsubscribe = subscribeToLogs((entry) => {
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ entry })}\n\n`);
        }
    });

    // App logs can be quiet for minutes; keep the stream under nginx's 60s proxy_read_timeout.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
    });
});


router.get('/config', async (req, res) => {
    const content = await readContainerFile(req.instance.containerName, req.instance.configPath);
    const config = parseLogConfig(content);
    res.json(config);
});

router.put('/config', async (req, res) => {
    const config = req.body;
    if (!config || typeof config !== 'object') {
        return res.status(400).json({ error: 'Invalid log config' });
    }

    logger.info('Log config update requested', { enabled: config.enabled });
    try {
        const result = await saveCaddyfileChange(req.instance, async previous => {
            const updated = updateGlobalBlock(previous, config);
            try { await validateCaddyfile(updated, req.instance); }
            catch (cause) { throw new AppError('CADDYFILE_VALIDATION_FAILED', { cause }); }
            return updated;
        }, { actor: getAuthentication().getActor(req), action: 'logs.configure' });
        logger.info('Log config saved and reloaded');
        res.json({ ok: true, message: 'Log config saved and reloaded', ...historyWarning(result) });
    } catch (err) {
        return sendAppError(res, asAppError(err, 'CADDYFILE_WRITE_FAILED', { instanceId: req.instance.id }));
    }
});

router.get('/', async (req, res) => {
    const { logPath, containerName } = req.instance;
    try {
        const { stdout } = await execInInstance(containerName, 'tail', ['-n', String(TAIL_LINES), logPath]);
        const lines = stdout.split('\n').filter(Boolean);
        res.json({ lines, path: logPath });
    } catch {
        res.json({ lines: [], error: `Log file not found at ${logPath}` });
    }
});

router.get('/stream', async (req, res) => {
    const { logPath, containerName } = req.instance;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const proc = spawnInInstance(containerName, 'tail', ['-n', '0', '-f', logPath]);
    let buffer = '';

    proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop();
        for (const line of parts.filter(Boolean)) {
            res.write(`data: ${JSON.stringify({ line })}\n\n`);
        }
    });

    proc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) {
            const missing = /no such file|not found/i.test(msg);
            const code = missing ? 'LOG_FILE_MISSING' : 'LOG_STREAM_ERROR';
            if (!missing) logger.error('Caddy log stream failed', { requestId: req.diagnosticId, code, detail: msg });
            res.write(`data: ${JSON.stringify({ error: msg, code, requestId: req.diagnosticId })}\n\n`);
        }
    });

    proc.on('error', () => {
        res.write(`data: ${JSON.stringify({ error: `Log file not found at ${logPath}`, code: 'LOG_FILE_MISSING', requestId: req.diagnosticId })}\n\n`);
        res.end();
    });

    proc.on('close', () => { if (!res.writableEnded) res.end(); });
    req.on('close', () => { proc.kill(); });
});

export default router;
export { appLogsRouter, parseLogConfig, buildLogBlock, updateGlobalBlock, extractGlobalBlock, extractDirectiveBlock };
