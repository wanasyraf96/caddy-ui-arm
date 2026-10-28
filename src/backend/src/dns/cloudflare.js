// Minimal Cloudflare API v4 client for the DNS page.
//
// - The token is used in the Authorization header and nowhere else: errors
//   carry method, path, status and Cloudflare's own errors[] only.
// - Pacing: Cloudflare allows 1200 requests per 5 minutes; stay under it per
//   token, and honour 429 Retry-After instead of failing a bulk apply halfway.
// - Pagination: every list call walks all pages. A single-page read would
//   silently truncate a zone with more than per_page records.
const BASE = 'https://api.cloudflare.com/client/v4';
const WINDOW_MS = 5 * 60 * 1000;
const WINDOW_LIMIT = 1100;          // margin under Cloudflare's 1200
const MAX_429_RETRIES = 5;

export class CloudflareError extends Error {
    constructor(method, path, status, errors = []) {
        const detail = errors.map(e => `${e.code}: ${e.message}`).join('; ');
        super(`Cloudflare ${method} ${path} returned ${status}${detail ? ` (${detail})` : ''}`);
        this.name = 'CloudflareError';
        this.status = status;
        this.errors = errors.map(e => ({ code: e.code, message: String(e.message || '').slice(0, 300) }));
    }
}

export function createClient({ fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    const windows = new Map();      // token -> request timestamps in the window

    async function pace(token) {
        const stamps = windows.get(token) || [];
        while (stamps.length && now() - stamps[0] > WINDOW_MS) stamps.shift();
        if (stamps.length >= WINDOW_LIMIT) {
            await sleep(WINDOW_MS - (now() - stamps[0]) + 50);
            return pace(token);
        }
        stamps.push(now());
        windows.set(token, stamps);
    }

    async function request(token, method, path, { body, query, raw = false } = {}) {
        const url = new URL(BASE + path);
        for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
        for (let attempt = 0; ; attempt++) {
            await pace(token);
            let response;
            try {
                response = await fetchImpl(url, {
                    method,
                    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                    body: body ? JSON.stringify(body) : undefined,
                });
            } catch (error) {
                // fetch's own failure carries no request headers; keep only its code.
                throw new CloudflareError(method, path, 0, [{ code: error.cause?.code || 'NETWORK', message: 'request failed' }]);
            }
            if (response.status === 429 && attempt < MAX_429_RETRIES) {
                const wait = Math.min(60, Number(response.headers.get('retry-after')) || 2 ** attempt);
                await sleep(wait * 1000);
                continue;
            }
            if (raw && response.ok) return response.text();
            let payload = null;
            try { payload = await response.json(); } catch { /* non-JSON error body */ }
            if (!response.ok || payload?.success === false) {
                throw new CloudflareError(method, path, response.status, payload?.errors || []);
            }
            return payload;
        }
    }

    async function listAll(token, path, query = {}, perPage = 100) {
        const out = [];
        for (let page = 1; ; page++) {
            const payload = await request(token, 'GET', path, { query: { ...query, page, per_page: perPage } });
            out.push(...(payload.result || []));
            const totalPages = payload.result_info?.total_pages || 1;
            if (page >= totalPages) return out;
        }
    }

    return {
        async verifyToken(token) {
            try {
                const payload = await request(token, 'GET', '/user/tokens/verify');
                return payload.result?.status === 'active' ? 'active' : (payload.result?.status || 'unknown');
            } catch (error) {
                if (error instanceof CloudflareError && (error.status === 401 || error.status === 403)) return 'invalid';
                throw error;
            }
        },
        listZones: token => listAll(token, '/zones', {}, 50),
        listRecords: (token, zoneId) => listAll(token, `/zones/${zoneId}/dns_records`),
        async getRecord(token, zoneId, recordId) {
            try {
                return (await request(token, 'GET', `/zones/${zoneId}/dns_records/${recordId}`)).result;
            } catch (error) {
                if (error instanceof CloudflareError && error.status === 404) return null;
                throw error;
            }
        },
        createRecord: async (token, zoneId, record) =>
            (await request(token, 'POST', `/zones/${zoneId}/dns_records`, { body: record })).result,
        updateRecord: async (token, zoneId, recordId, record) =>
            (await request(token, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, { body: record })).result,
        deleteRecord: async (token, zoneId, recordId) =>
            (await request(token, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`)).result,
        exportZone: (token, zoneId) => request(token, 'GET', `/zones/${zoneId}/dns_records/export`, { raw: true }),
    };
}

export const cloudflare = createClient();
