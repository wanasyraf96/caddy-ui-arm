import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { AppError } from '../AppError.js';
import { findAccount, loadAccounts, publicAccount } from './accounts.js';
import { cloudflare as defaultClient, CloudflareError } from './cloudflare.js';

// Cloudflare stays the source of truth: nothing here caches records between
// requests. Every write goes stage -> preview -> apply, and apply re-runs the
// preview itself, so a record edited in the Cloudflare dashboard after it was
// staged is refused rather than overwritten.
//
// Before anything is written, the live state of every record about to change
// is saved as a snapshot (JSON) — the rollback material. A snapshot becomes a
// revert plan that goes through the same preview/apply path.
export const SNAPSHOT_DIR = process.env.CADDY_UI_DNS_SNAPSHOTS || '/var/lib/caddy-ui-dns';
export const EDITABLE_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX'];
const ID = /^[A-Za-z0-9]{1,64}$/;
const SNAPSHOT_ID = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
const MAX_CHANGES = 1000;

function shapeRecord(account, zone, r) {
    return {
        account: account.name, zoneId: zone.id, zone: zone.name,
        id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl,
        proxied: Boolean(r.proxied), proxiable: Boolean(r.proxiable),
        comment: r.comment ?? null, priority: r.priority ?? null, modified_on: r.modified_on ?? null,
    };
}

function liveFields(r) {
    return { type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: Boolean(r.proxied),
        comment: r.comment ?? null, priority: r.priority ?? null, modified_on: r.modified_on ?? null };
}

function safeError(error) {
    if (error instanceof CloudflareError) return { status: error.status, errors: error.errors };
    if (error instanceof AppError) return { status: error.status, errors: [{ code: error.code, message: error.message }] };
    return { status: 0, errors: [{ code: 'UNEXPECTED', message: 'unexpected error' }] };
}

// ── validation ────────────────────────────────────────────────────────────────

function invalid(message, context = {}) {
    return new AppError('VALIDATION_FAILED', { message, context });
}

function validRecordBody(after, index) {
    if (!after || typeof after !== 'object') throw invalid('record body required', { index });
    const { type, name, content, ttl = 1, proxied = false, comment = null, priority = null } = after;
    if (!EDITABLE_TYPES.includes(type)) throw invalid(`type must be one of ${EDITABLE_TYPES.join(', ')}`, { index });
    if (typeof name !== 'string' || !name.trim() || name.length > 255) throw invalid('name required', { index });
    if (typeof content !== 'string' || !content.trim() || content.length > 4096) throw invalid('content required', { index });
    if (!(ttl === 1 || (Number.isInteger(ttl) && ttl >= 60 && ttl <= 86400))) throw invalid('ttl must be 1 (auto) or 60-86400', { index });
    if (typeof proxied !== 'boolean') throw invalid('proxied must be boolean', { index });
    if (proxied && !['A', 'AAAA', 'CNAME'].includes(type)) throw invalid('only A, AAAA and CNAME can be proxied', { index });
    if (comment !== null && (typeof comment !== 'string' || comment.length > 100)) throw invalid('comment must be text up to 100 characters', { index });
    const body = { type, name: name.trim(), content: content.trim(), ttl, proxied, comment: comment || null };
    if (type === 'MX') {
        if (!Number.isInteger(priority) || priority < 0 || priority > 65535) throw invalid('MX needs a priority 0-65535', { index });
        body.priority = priority;
    }
    return body;
}

export function validateChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) throw invalid('changes must be a non-empty array');
    if (changes.length > MAX_CHANGES) throw invalid(`at most ${MAX_CHANGES} changes per request`);
    return changes.map((c, index) => {
        if (!['create', 'update', 'delete'].includes(c?.op)) throw invalid('op must be create, update or delete', { index });
        if (typeof c.account !== 'string' || !c.account) throw invalid('account required', { index });
        if (!ID.test(c.zoneId || '')) throw invalid('zoneId invalid', { index });
        const out = { op: c.op, account: c.account, zoneId: c.zoneId };
        if (c.op !== 'create') {
            if (!ID.test(c.recordId || '')) throw invalid('recordId invalid', { index });
            if (typeof c.before?.modified_on !== 'string') throw invalid('before.modified_on required — stage from a fresh read', { index });
            out.recordId = c.recordId;
            out.before = { modified_on: c.before.modified_on };
        }
        if (c.op !== 'delete') out.after = validRecordBody(c.after, index);
        return out;
    });
}

// ── reads ─────────────────────────────────────────────────────────────────────

export async function inventory({ client = defaultClient } = {}) {
    const accounts = await loadAccounts();
    const outAccounts = [];
    const records = [];
    for (const account of accounts) {
        try {
            const status = await client.verifyToken(account.token);
            if (status !== 'active') { outAccounts.push(publicAccount(account, { status, zones: [] })); continue; }
            const zones = await client.listZones(account.token);
            for (const zone of zones) {
                for (const r of await client.listRecords(account.token, zone.id)) records.push(shapeRecord(account, zone, r));
            }
            outAccounts.push(publicAccount(account, { status, zones: zones.map(z => ({ id: z.id, name: z.name })) }));
        } catch (error) {
            outAccounts.push(publicAccount(account, { status: 'error', zones: [], error: safeError(error) }));
        }
    }
    return { accounts: outAccounts, records };
}

// ── preview / apply ───────────────────────────────────────────────────────────

// The live re-check reads each touched zone's record list ONCE (paged, 100 per
// call) instead of one GET per record: ~3 calls per 100 records, not 100.
// Per-record GETs made a 230-record repoint cost ~700 calls and tripped the
// rate window on the next operation.
export async function preview(rawChanges, { client = defaultClient } = {}) {
    const changes = validateChanges(rawChanges);
    const zoneCache = new Map();
    const liveCache = new Map();
    const liveRecord = async (account, zoneId, recordId) => {
        const key = `${account.name}|${zoneId}`;
        if (!liveCache.has(key)) liveCache.set(key, new Map((await client.listRecords(account.token, zoneId)).map(r => [r.id, r])));
        return liveCache.get(key).get(recordId) || null;
    };
    const out = [];
    for (const change of changes) {
        let account;
        try {
            account = await findAccount(change.account);
        } catch {
            out.push({ ...change, status: 'refused', reason: 'unknown account' });
            continue;
        }
        if (!zoneCache.has(account.name)) zoneCache.set(account.name, await client.listZones(account.token));
        const zone = zoneCache.get(account.name).find(z => z.id === change.zoneId);
        if (!zone) { out.push({ ...change, status: 'refused', reason: 'zone not in this account' }); continue; }
        if (change.op === 'create') { out.push({ ...change, zone: zone.name, status: 'ok' }); continue; }
        const live = await liveRecord(account, change.zoneId, change.recordId);
        if (!live) { out.push({ ...change, zone: zone.name, status: 'refused', reason: 'record no longer exists' }); continue; }
        if (live.modified_on !== change.before.modified_on) {
            out.push({ ...change, zone: zone.name, status: 'refused', reason: 'changed since staged — refresh and stage again', current: liveFields(live) });
            continue;
        }
        out.push({ ...change, zone: zone.name, status: 'ok', current: liveFields(live) });
    }
    return out;
}

async function writeSnapshot(snapshot) {
    await mkdir(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    const file = join(SNAPSHOT_DIR, `${snapshot.id}.json`);
    await writeFile(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    await chmod(file, 0o600);
}

export async function apply(rawChanges, { actor = null, client = defaultClient, onProgress = () => {} } = {}) {
    const planned = await preview(rawChanges, { client });
    onProgress({ total: planned.length, done: 0 });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const snapshot = { id: `${stamp}-${randomBytes(4).toString('hex')}`, createdAt: new Date().toISOString(), actor, changes: planned, results: [] };
    // Written BEFORE the first change: if the process dies mid-apply, the
    // before-state is already on disk.
    await writeSnapshot(snapshot);

    for (const change of planned) {
        if (change.status !== 'ok') { snapshot.results.push({ status: 'refused', reason: change.reason }); continue; }
        try {
            const account = await findAccount(change.account);
            let record = null;
            if (change.op === 'create') record = await client.createRecord(account.token, change.zoneId, change.after);
            else if (change.op === 'update') record = await client.updateRecord(account.token, change.zoneId, change.recordId, change.after);
            else await client.deleteRecord(account.token, change.zoneId, change.recordId);
            snapshot.results.push({ status: 'applied', record: record ? { id: record.id, ...liveFields(record) } : null });
        } catch (error) {
            snapshot.results.push({ status: 'failed', error: safeError(error) });
        }
        onProgress({ total: planned.length, done: snapshot.results.length });
    }
    await writeSnapshot(snapshot);
    return { snapshotId: snapshot.id, results: snapshot.results.map((r, i) => ({ ...r, op: planned[i].op, zone: planned[i].zone, name: planned[i].after?.name ?? planned[i].current?.name ?? null })) };
}

// ── apply jobs ────────────────────────────────────────────────────────────────
// An apply can outlast any HTTP request: hundreds of writes, paced under
// Cloudflare's rate limit, behind upstream's nginx with its fixed 60s proxy
// timeout. So POST /apply starts a job and returns at once; the page polls.
// Jobs live in memory (the last 20); the snapshot on disk is the durable record.
const jobs = new Map();
const MAX_JOBS = 20;

export function startApply(rawChanges, { actor = null, client = defaultClient } = {}) {
    validateChanges(rawChanges);            // bad input fails the request, not the job
    const id = randomBytes(8).toString('hex');
    const job = { id, state: 'running', total: rawChanges.length, done: 0, startedAt: new Date().toISOString(), result: null, error: null };
    jobs.set(id, job);
    while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
    job.promise = apply(rawChanges, { actor, client, onProgress: p => Object.assign(job, p) })
        .then(result => { job.state = 'done'; job.result = result; })
        .catch(error => { job.state = 'failed'; job.error = safeError(error); });
    return job;
}

export function getJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    const { promise, ...visible } = job;    // eslint-disable-line no-unused-vars
    return visible;
}

// ── snapshots / revert ────────────────────────────────────────────────────────

async function readSnapshot(id) {
    if (!SNAPSHOT_ID.test(id)) throw invalid('snapshot id invalid');
    try {
        return JSON.parse(await readFile(join(SNAPSHOT_DIR, `${id}.json`), 'utf8'));
    } catch {
        throw new AppError('VALIDATION_FAILED', { message: 'snapshot not found', context: { id } });
    }
}

export async function listSnapshots() {
    let names;
    try { names = (await readdir(SNAPSHOT_DIR)).filter(n => n.endsWith('.json')).sort().reverse().slice(0, 50); } catch { return []; }
    const out = [];
    for (const n of names) {
        try {
            const s = JSON.parse(await readFile(join(SNAPSHOT_DIR, n), 'utf8'));
            const count = st => s.results.filter(r => r.status === st).length;
            out.push({ id: s.id, createdAt: s.createdAt, actor: s.actor, changes: s.changes.length, applied: count('applied'), failed: count('failed'), refused: count('refused') });
        } catch { /* unreadable snapshot: skip */ }
    }
    return out;
}

function bodyOf(fields) {
    const { type, name, content, ttl, proxied, comment, priority } = fields;
    return { type, name, content, ttl, proxied, comment, ...(type === 'MX' ? { priority } : {}) };
}

// Invert every APPLIED change, newest first. The result is an ordinary change
// list: the caller previews and applies it like any other.
export async function revertPlan(id) {
    const snapshot = await readSnapshot(id);
    const plan = [];
    snapshot.changes.forEach((change, i) => {
        const result = snapshot.results[i];
        if (result?.status !== 'applied') return;
        const base = { account: change.account, zoneId: change.zoneId };
        if (change.op === 'create' && result.record) {
            plan.push({ ...base, op: 'delete', recordId: result.record.id, before: { modified_on: result.record.modified_on } });
        } else if (change.op === 'update' && result.record) {
            plan.push({ ...base, op: 'update', recordId: change.recordId, before: { modified_on: result.record.modified_on }, after: bodyOf(change.current) });
        } else if (change.op === 'delete') {
            plan.push({ ...base, op: 'create', after: bodyOf(change.current) });
        }
    });
    return plan.reverse();
}

// ── export ────────────────────────────────────────────────────────────────────

export async function exportBind(zones, { client = defaultClient } = {}) {
    const parts = [];
    for (const { account: name, zoneId } of zones) {
        if (!ID.test(zoneId || '')) throw invalid('zoneId invalid');
        const account = await findAccount(name);
        parts.push(`;; ===== account: ${account.name}  zone id: ${zoneId} =====\n${await client.exportZone(account.token, zoneId)}`);
    }
    return parts.join('\n');
}
