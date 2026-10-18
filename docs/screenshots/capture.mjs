import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { backendEnvironment, checkDocker, docker, Harness, IMAGE } from '../../dev/dev-caddy/harness.mjs';
import { CAPTURE_VERSION, normalizeCapture, validateCapture } from '../../dev/playground/capture-format.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');

// Each site proxies to a listener the capture process owns, so upstream checks
// are real and online; addresses are rewritten to these LAN-style ones.
const SITES = [
    { host: 'homeassistant.internal', title: 'Home Assistant', upstream: '192.168.1.10:8123' },
    { host: 'jellyfin.internal', title: 'Jellyfin', upstream: '192.168.1.20:8096' },
    { host: 'immich.internal', title: 'Immich', upstream: '192.168.1.30:2283' },
];

function richCaddyfile(upstreams) {
    const sites = SITES.map((site, i) => `${site.host} {
    # ${site.title}
    import access_log
    tls internal

    handle /healthz {
        respond "OK" 200
    }

    handle {
        reverse_proxy ${upstreams[i]}
    }
}
`);
    return `{
    admin 0.0.0.0:2019
    auto_https disable_redirects
    metrics
}

(access_log) {
    log {
        output file /data/dev-caddy/logs/access.log
        format json
    }
}

${sites.join('\n')}`;
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`127.0.0.1:${server.address().port}`));
    });
}

async function until(signal, timeoutMs, description, check) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

export async function captureScreenshots({ output = resolve(import.meta.dirname, 'captures/screenshots.json'), backendEntry = resolve(root, 'src/backend/src/index.js'), onNamespace = () => {} } = {}) {
    if (process.platform === 'win32') throw new Error('Capture requires a Unix socket.');
    await checkDocker();
    const context = process.env.DOCKER_CONTEXT;
    const endpoint = !context && process.env.DOCKER_HOST ? process.env.DOCKER_HOST
        : (await exec('docker', ['context', 'inspect', ...(context ? [context] : []), '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim();
    if (!endpoint.startsWith('unix://')) throw new Error('Capture needs a Unix Docker socket.');
    const directory = await mkdtemp(resolve(tmpdir(), 'caddy-ui-screenshots-'));
    const harness = new Harness(randomBytes(8).toString('hex'));
    let backend;
    const upstreamServers = SITES.map(() => createServer((req, res) => res.end('OK')));
    let outputLog = '';
    let result;
    let failure;
    const socketPath = resolve(directory, 'backend.sock');
    const startup = new AbortController();
    const interrupt = () => startup.abort(new Error('Capture interrupted.'));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);

    const requestContexts = new Map();
    async function api(path, method = 'GET', body = null) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !requestContexts.get(socketPath)?.['X-CSRF-Token']) await api('/auth/csrf');
        return new Promise((resolve, reject) => {
            const call = request({ socketPath, path: '/api' + path, method, timeout: 5000, signal: startup.signal,
                headers: { ...requestContexts.get(socketPath), 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'X-Instance-Id': 'default' } }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('error', reject);
                response.on('end', () => {
                    try {
                        const text = Buffer.concat(chunks).toString();
                        const headers = Object.fromEntries(['content-type', 'x-request-id'].filter(key => response.headers[key]).map(key => [key, response.headers[key]]));
                        const cookie = response.headers['set-cookie']?.at(-1);
                        if (cookie) requestContexts.set(socketPath, { Cookie: cookie.split(';')[0] });
                        if (path === '/auth/csrf') requestContexts.set(socketPath, {
                            ...requestContexts.get(socketPath), 'X-CSRF-Token': JSON.parse(text).csrfToken,
                        });
                        resolve({ request: { method, path, body }, response: {
                            status: response.statusCode, headers,
                            body: headers['content-type']?.includes('application/json') ? JSON.parse(text) : text,
                        } });
                    } catch (error) { reject(error); }
                });
            });
            call.on('timeout', () => call.destroy(new Error(`Capture request timed out: ${method} ${path}`)));
            call.on('error', reject);
            if (body !== null) call.write(typeof body === 'string' ? body : JSON.stringify(body));
            call.end();
        });
    }

    async function successful(path, method, body) {
        const record = await api(path, method, body);
        assert(record.response.status >= 200 && record.response.status < 300, `${method || 'GET'} ${path}: ${JSON.stringify(record.response.body)}`);
        return record;
    }

    try {
        onNamespace(harness.project);
        assert.deepEqual(await harness.names(), []);
        assert.deepEqual(await harness.names('volume'), []);
        const upstreams = await Promise.all(upstreamServers.map(listen));
        const info = await harness.create('screenshots');
        const { '.': appVersion } = JSON.parse(await readFile(resolve(root, '.release-please-manifest.json'), 'utf8'));
        const env = { ...backendEnvironment(directory, info.instance), PORT: socketPath,
            DOCKER_SOCKET: fileURLToPath(endpoint.replace(/^unix:/, 'file:')),
            APP_VERSION: appVersion, CADDY_UI_PUBLIC_METRICS: 'false', CADDY_UI_ADDITIONAL_LANGUAGES: '',
            CADDY_SERVER_NAME: 'srv0', NODE_ENV: 'development' };
        for (const key of ['CADDY_UI_USER', 'CADDY_UI_PASSWORD', 'JWT_SECRET']) delete env[key];
        await mkdir(resolve(directory, 'backend'), { recursive: true });
        backend = spawn(process.execPath, [backendEntry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        for (const stream of [backend.stdout, backend.stderr]) stream.on('data', data => { outputLog = (outputLog + data).slice(-64000); });
        backend.on('error', error => startup.abort(error));
        backend.once('close', (code, signal) => startup.abort(new Error(`Capture backend exited (${code ?? signal}).\n${outputLog}`)));
        const deadline = Date.now() + 15000;
        let ready = false;
        while (Date.now() < deadline) {
            startup.signal.throwIfAborted();
            try {
                const version = await api('/version');
                if (version.response.body.version === env.APP_VERSION) { ready = true; break; }
            } catch { startup.signal.throwIfAborted(); }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        startup.signal.throwIfAborted();
        if (!ready) throw new Error(`Capture backend did not become ready.\n${outputLog}`);

        await successful('/auth/setup', 'POST', { username: 'capture-administrator', password: randomBytes(24).toString('base64url') });
        const csrfRecord = await successful('/auth/csrf');
        csrfRecord.response.body.csrfToken = 'offline-preview-context';
        await successful('/settings', 'PUT', { firstTimeRun: false, language: 'en', theme: 'dark' });

        // Enrich state: enable metrics and set a server label. Route titles
        // come from the Caddyfile's title comments.
        await successful('/metrics/config', 'PUT', { enabled: true });
        await successful('/server-names/srv0', 'PUT', { name: 'Production HTTPS' });

        // Exercise the real session/CSRF-protected configuration-write path.
        await successful('/caddyfile?fmt=false&sort=false', 'PUT', richCaddyfile(upstreams));

        // Caddy issues the internal certificates in the background after a load.
        await until(startup.signal, 30000, 'internal certificates', async () => {
            const tls = await api('/tls');
            return tls.response.status === 200 && tls.response.body.filter(cert => cert.status === 'valid').length === SITES.length;
        });

        // The sites only listen on HTTPS inside the container, so generate
        // access log entries and request metrics from there.
        const hosts = SITES.map(site => site.host).join(' ');
        await docker(['exec', info.instance.containerName, 'sh', '-c',
            `echo "127.0.0.1 ${hosts}" >> /etc/hosts; for i in 1 2 3 4; do for host in ${hosts}; do wget -q -O /dev/null "https://$host/healthz" || exit 1; done; done`]);

        // The upstream monitor records every 30s; wait for two samples of
        // each upstream so uptime percentages are real measurements.
        await until(startup.signal, 75000, 'upstream uptime history', async () => {
            const uptime = (await api('/health/uptime')).response.body;
            return upstreams.every(upstream => uptime[upstream]?.total >= 2);
        });

        // Configure notifications (provider config, not sending).
        await successful('/notifications/config', 'PUT', {
            enabled: true, provider: 'ntfy', ntfy: { url: 'https://ntfy.example.com/caddy-alerts' },
            triggers: { upstreamOffline: false, upstreamOnline: false, certExpiring: false, updateAvailable: false, routeOffline: false, routeOnline: false },
            debounceMinutes: 30,
        });

        // Both entries belong to disposable Caddy instances, so capture never
        // probes an unrelated LAN service to populate the Instances view.
        const staging = await harness.create('staging');
        await successful('/instances', 'POST', {
            ...staging.instance, name: 'Staging Server',
        });

        // Capture global endpoints.
        const requests = [];
        requests.push(await successful('/languages'));
        requests.push(await successful('/settings'));
        requests.push(await successful('/custom-themes'));
        requests.push(await successful('/version'));
        requests.push(await successful('/version?frontend=' + encodeURIComponent(process.env.VITE_APP_VERSION || 'dev')));
        requests.push(await successful('/instances'));
        requests.push(await successful('/instances/status'));
        const authCheck = await successful('/auth/status');
        requests.push(authCheck);

        // Dashboard.
        requests.push(await successful('/status'));
        requests.push(await successful('/status/process'));
        requests.push(await successful('/server-names'));
        requests.push(await successful('/health'));

        // Caddyfile.
        requests.push(await successful('/caddyfile'));
        const history = await successful('/caddyfile/history');
        requests.push(history);
        for (const entry of history.response.body) requests.push(await successful('/caddyfile/history/' + encodeURIComponent(entry.filename)));

        // Routes.
        requests.push(await successful('/routes'));
        requests.push(await successful('/tls'));
        requests.push(await successful('/route-notes'));
        requests.push(await successful('/routes/maintenance'));
        requests.push(await successful('/health/uptime'));
        requests.push(await successful('/health/uptime?kind=route'));

        // TLS (shares /tls from routes above).

        // Logs.
        requests.push(await successful('/logs'));
        requests.push(await successful('/logs/config'));

        // Metrics.
        requests.push(await successful('/metrics'));
        requests.push(await successful('/metrics/config'));

        // Notifications.
        requests.push(await successful('/notifications/config'));

        // Instances — server-names/all and per-instance server query.
        requests.push(await successful('/server-names/all'));
        requests.push(await successful('/instances/servers?adminUrl=' + encodeURIComponent(info.instance.adminUrl)));
        requests.push(await successful('/instances/servers?adminUrl=' + encodeURIComponent(staging.instance.adminUrl)));

        const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
        result = validateCapture({ formatVersion: CAPTURE_VERSION,
            source: { commit: commit.trim(), caddyImage: IMAGE },
            csrfContext: { source: { commit: commit.trim() }, record: normalizeCapture(csrfRecord) },
            normalization: ['Request IDs', 'ISO timestamps', 'Private capture addresses and paths; measurements remain as observed'],
            scenarios: normalizeCapture([{ id: 'screenshots', requests }], [
                ...upstreams.map((upstream, i) => [upstream, SITES[i].upstream]),
                [encodeURIComponent(staging.instance.adminUrl), encodeURIComponent('http://caddy-staging:2019')],
                [staging.instance.adminUrl, 'http://caddy-staging:2019'],
                [staging.instance.containerName, 'caddy-ui-dev-staging'],
                [encodeURIComponent(info.instance.adminUrl), encodeURIComponent('http://caddy-screenshots:2019')],
                [info.instance.adminUrl, 'http://caddy-screenshots:2019'],
                [new URL(info.instance.adminUrl).host, 'caddy-screenshots:2019'],
                [info.httpUrl, 'http://caddy-screenshots:80'],
                [new URL(info.httpUrl).host, 'caddy-screenshots:80'],
                [info.instance.containerName, 'caddy-ui-dev-screenshots'], [directory, '/capture-state'],
            ]),
        });
    } catch (error) { failure = error; }

    const cleanupErrors = [];
    if (backend && backend.exitCode === null && backend.signalCode === null) {
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => backend.kill('SIGKILL'), 3000);
                backend.once('close', () => { clearTimeout(timer); resolve(); });
                backend.once('error', reject);
                backend.kill('SIGTERM');
            });
        } catch (error) { cleanupErrors.push(error); }
    }
    for (const server of upstreamServers) {
        if (!server.listening) continue;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
    try { await harness.removeAll({ confirmed: true, purge: true }); } catch (error) { cleanupErrors.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (failure || cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors].filter(Boolean), 'Capture failed; no artifact was written.', { cause: failure });
    await mkdir(resolve(output, '..'), { recursive: true });
    const temporaryOutput = `${output}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        await writeFile(temporaryOutput, JSON.stringify(result, null, 2) + '\n');
        await rename(temporaryOutput, output);
    } finally { await rm(temporaryOutput, { force: true }); }
    return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [output, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Usage: node docs/screenshots/capture.mjs [output.json]');
    try {
        const capture = await captureScreenshots({ ...(output ? { output: resolve(output) } : {}),
            onNamespace: project => console.log(`Capture owns Docker namespace ${project}.`) });
        console.log(`Captured ${capture.scenarios[0].requests.length} API responses from ${capture.source.commit}. Resources cleaned up.`);
    } catch (error) { console.error(error, error.cause); process.exitCode = 1; }
}
