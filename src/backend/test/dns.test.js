import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// A token that must never appear in any output, error, snapshot or log.
const SENTINEL = 'SENTINEL_TOKEN_must_never_leak_0123456789';
let dir;
let snapDir;
let accounts;
let cloudflare;
let service;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'caddy-ui-dns-'));
    snapDir = join(dir, 'snapshots');
    process.env.CADDY_UI_DNS_DIR = dir;
    process.env.CADDY_UI_DNS_SNAPSHOTS = snapDir;
    accounts = await import('../src/dns/accounts.js');
    cloudflare = await import('../src/dns/cloudflare.js');
    service = await import('../src/dns/service.js');
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.CADDY_UI_DNS_DIR;
    delete process.env.CADDY_UI_DNS_SNAPSHOTS;
});

async function setAccounts(value) {
    await writeFile(join(dir, 'accounts.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

// In-memory Cloudflare: one zone per token, records with modified_on.
function fakeClient() {
    let seq = 0;
    const stamp = () => `2026-10-28T00:00:${String(++seq).padStart(2, '0')}.000Z`;
    const zones = { [SENTINEL]: [{ id: 'zone1', name: 'example.com' }] };
    const records = new Map();
    const add = r => { const rec = { id: `rec${++seq}`, ttl: 1, proxied: false, ...r, modified_on: stamp() }; records.set(rec.id, rec); return rec; };
    add({ type: 'A', name: 'a.example.com', content: '13.229.210.129' });
    add({ type: 'CNAME', name: 'b.example.com', content: 'mbi.vectolabs.com' });
    const calls = [];
    return {
        records, add, calls,
        async verifyToken(token) { return zones[token] ? 'active' : 'invalid'; },
        async listZones(token) { return zones[token] || []; },
        async listRecords() { return [...records.values()]; },
        async getRecord(token, zoneId, id) { return records.get(id) || null; },
        async createRecord(token, zoneId, body) { calls.push(['create', body.name]); return add(body); },
        async updateRecord(token, zoneId, id, body) {
            calls.push(['update', id]);
            const rec = { ...records.get(id), ...body, modified_on: stamp() };
            records.set(id, rec);
            return rec;
        },
        async deleteRecord(token, zoneId, id) { calls.push(['delete', id]); records.delete(id); return { id }; },
        async exportZone() { return '$ORIGIN example.com.\n'; },
    };
}

describe('accounts', () => {
    beforeEach(() => rm(join(dir, 'accounts.json'), { force: true }));

    it('treats a missing file as zero accounts', async () => {
        expect(await accounts.loadAccounts()).toEqual([]);
    });

    it('never quotes the file in a parse error', async () => {
        await setAccounts(`[{"name": "main", "token": "${SENTINEL}",]`);
        const error = await accounts.loadAccounts().catch(e => e);
        expect(JSON.stringify({ m: error.message, c: error.context })).not.toContain(SENTINEL);
    });

    it('rejects duplicate names and malformed tokens without echoing the token', async () => {
        await setAccounts([{ name: 'main', token: SENTINEL }, { name: 'main', token: SENTINEL }]);
        await expect(accounts.loadAccounts()).rejects.toThrow(/duplicated/);
        await setAccounts([{ name: 'main', token: 'short' }]);
        const error = await accounts.loadAccounts().catch(e => e);
        expect(error.message).toMatch(/malformed/);
        expect(JSON.stringify(error.context)).not.toContain('short');
    });

    it('builds public objects from an allowlist', () => {
        expect(accounts.publicAccount({ name: 'main', token: SENTINEL, extra: 1 }, { status: 'active' })).toEqual({ name: 'main', status: 'active' });
    });
});

describe('cloudflare client', () => {
    function respond(status, body, headers = {}) {
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    }

    it('walks every page', async () => {
        const pages = [1, 2, 3].map(p => ({ success: true, result: [{ id: `r${p}` }], result_info: { page: p, total_pages: 3 } }));
        const seen = [];
        const client = cloudflare.createClient({ fetchImpl: async url => { const p = Number(url.searchParams.get('page')); seen.push(p); return respond(200, pages[p - 1]); } });
        expect((await client.listRecords('t'.repeat(30), 'zone1')).map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
        expect(seen).toEqual([1, 2, 3]);
    });

    it('waits out a 429 using Retry-After, then succeeds', async () => {
        const waits = [];
        let n = 0;
        const client = cloudflare.createClient({
            sleep: async ms => { waits.push(ms); },
            fetchImpl: async () => (++n <= 2 ? respond(429, { success: false, errors: [] }, { 'Retry-After': '3' }) : respond(200, { success: true, result: [], result_info: { total_pages: 1 } })),
        });
        await client.listZones('t'.repeat(30));
        expect(n).toBe(3);
        expect(waits).toEqual([3000, 3000]);
    });

    it('carries Cloudflare errors but never the token', async () => {
        const client = cloudflare.createClient({ fetchImpl: async () => respond(403, { success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] }) });
        const error = await client.listZones(SENTINEL).catch(e => e);
        expect(error.status).toBe(403);
        expect(error.errors[0].code).toBe(9109);
        expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(SENTINEL);
    });

    it('reports an invalid token instead of throwing', async () => {
        const client = cloudflare.createClient({ fetchImpl: async () => respond(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }) });
        expect(await client.verifyToken(SENTINEL)).toBe('invalid');
    });

    it('paces itself under the window limit', async () => {
        let clock = 0;
        const sleeps = [];
        const client = cloudflare.createClient({
            now: () => clock,
            sleep: async ms => { sleeps.push(ms); clock += ms; },
            fetchImpl: async () => respond(200, { success: true, result: { status: 'active' } }),
        });
        for (let i = 0; i < 1101; i++) await client.verifyToken('t'.repeat(30));
        expect(sleeps.length).toBe(1);
        expect(sleeps[0]).toBeGreaterThan(5 * 60 * 1000 - 1);
    });
});

describe('service', () => {
    let client;
    beforeEach(async () => {
        await setAccounts([{ name: 'main', token: SENTINEL }]);
        await rm(snapDir, { recursive: true, force: true });
        client = fakeClient();
    });

    it('inventories records with no token anywhere in the result', async () => {
        const inv = await service.inventory({ client });
        expect(inv.accounts).toEqual([{ name: 'main', status: 'active', zones: [{ id: 'zone1', name: 'example.com' }] }]);
        expect(inv.records).toHaveLength(2);
        expect(JSON.stringify(inv)).not.toContain(SENTINEL);
    });

    it('validates changes', () => {
        expect(() => service.validateChanges([])).toThrow();
        expect(() => service.validateChanges([{ op: 'update', account: 'main', zoneId: 'zone1', recordId: 'rec1', after: { type: 'A', name: 'a', content: '1.2.3.4' } }])).toThrow(/modified_on/);
        expect(() => service.validateChanges([{ op: 'create', account: 'main', zoneId: 'zone1', after: { type: 'TXT', name: 'a', content: 'x', proxied: true } }])).toThrow(/proxied/);
        expect(() => service.validateChanges([{ op: 'create', account: 'main', zoneId: 'zone1', after: { type: 'MX', name: 'a', content: 'mx.example.com' } }])).toThrow(/priority/);
    });

    it('refuses a record edited after it was staged (dashboard edit wins)', async () => {
        const rec = [...client.records.values()][0];
        const staged = { op: 'update', account: 'main', zoneId: 'zone1', recordId: rec.id, before: { modified_on: rec.modified_on }, after: { type: 'A', name: rec.name, content: '56.68.85.155' } };
        await client.updateRecord(SENTINEL, 'zone1', rec.id, { comment: 'edited in the dashboard' });
        const result = await service.apply([staged], { client, actor: 'admin' });
        expect(result.results[0].status).toBe('refused');
        expect(client.records.get(rec.id).content).toBe('13.229.210.129');
    });

    it('bulk repoint: applies per record, snapshot written first, revert restores', async () => {
        const recs = [...client.records.values()];
        const changes = recs.map(r => ({ op: 'update', account: 'main', zoneId: 'zone1', recordId: r.id, before: { modified_on: r.modified_on },
            after: { type: r.type, name: r.name, content: r.type === 'A' ? '56.68.85.155' : 'nginx-proxy.vectolabs.com' } }));
        const result = await service.apply(changes, { client, actor: 'admin' });
        expect(result.results.map(r => r.status)).toEqual(['applied', 'applied']);
        expect([...client.records.values()].map(r => r.content).sort()).toEqual(['56.68.85.155', 'nginx-proxy.vectolabs.com']);

        const files = await readdir(snapDir);
        expect(files).toEqual([`${result.snapshotId}.json`]);
        const snap = await readFile(join(snapDir, files[0]), 'utf8');
        expect(snap).toContain('13.229.210.129');          // before-state kept
        expect(snap).not.toContain(SENTINEL);

        const plan = await service.revertPlan(result.snapshotId);
        await service.apply(plan, { client, actor: 'admin' });
        expect([...client.records.values()].map(r => r.content).sort()).toEqual(['13.229.210.129', 'mbi.vectolabs.com']);
    });

    it('a failed record does not stop the rest, and is reported', async () => {
        const recs = [...client.records.values()];
        client.updateRecord = async (t, z, id, body) => {
            if (id === recs[0].id) throw new cloudflare.CloudflareError('PATCH', `/zones/z/dns_records/${id}`, 400, [{ code: 81057, message: 'Record already exists.' }]);
            return { ...client.records.get(id), ...body, modified_on: 'x' };
        };
        const changes = recs.map(r => ({ op: 'update', account: 'main', zoneId: 'zone1', recordId: r.id, before: { modified_on: r.modified_on }, after: { type: r.type, name: r.name, content: r.type === 'A' ? '9.9.9.9' : 'x.example.com' } }));
        const result = await service.apply(changes, { client });
        expect(result.results.map(r => r.status)).toEqual(['failed', 'applied']);
        expect(result.results[0].error.errors[0].code).toBe(81057);
    });

    it('create then revert deletes what was created; delete then revert recreates', async () => {
        const created = await service.apply([{ op: 'create', account: 'main', zoneId: 'zone1', after: { type: 'TXT', name: 'new.example.com', content: 'hello' } }], { client });
        expect([...client.records.values()].some(r => r.name === 'new.example.com')).toBe(true);
        await service.apply(await service.revertPlan(created.snapshotId), { client });
        expect([...client.records.values()].some(r => r.name === 'new.example.com')).toBe(false);

        const victim = [...client.records.values()][1];
        const deleted = await service.apply([{ op: 'delete', account: 'main', zoneId: 'zone1', recordId: victim.id, before: { modified_on: victim.modified_on } }], { client });
        expect(client.records.has(victim.id)).toBe(false);
        await service.apply(await service.revertPlan(deleted.snapshotId), { client });
        expect([...client.records.values()].some(r => r.name === victim.name && r.content === victim.content)).toBe(true);
    });

    it('re-checks by listing each zone once, not one GET per record', async () => {
        let gets = 0;
        let lists = 0;
        const listRecords = client.listRecords;
        client.getRecord = async () => { gets++; return null; };
        client.listRecords = async (...a) => { lists++; return listRecords(...a); };
        const recs = [...client.records.values()];
        await service.preview(recs.map(r => ({ op: 'delete', account: 'main', zoneId: 'zone1', recordId: r.id, before: { modified_on: r.modified_on } })), { client });
        expect(gets).toBe(0);
        expect(lists).toBe(1);
    });

    it('runs an apply as a job with progress', async () => {
        const r = [...client.records.values()][0];
        const job = service.startApply([{ op: 'delete', account: 'main', zoneId: 'zone1', recordId: r.id, before: { modified_on: r.modified_on } }], { client });
        expect(service.getJob(job.id).state).toBe('running');
        await job.promise;
        const done = service.getJob(job.id);
        expect(done).toMatchObject({ state: 'done', total: 1, done: 1 });
        expect(done.result.results[0].status).toBe('applied');
        expect(done).not.toHaveProperty('promise');
        expect(() => service.startApply([], { client })).toThrow();
    });

    it('refuses a zone that is not in the named account', async () => {
        const result = await service.preview([{ op: 'create', account: 'main', zoneId: 'otherzone', after: { type: 'A', name: 'x', content: '1.1.1.1' } }], { client });
        expect(result[0]).toMatchObject({ status: 'refused', reason: 'zone not in this account' });
    });
});
