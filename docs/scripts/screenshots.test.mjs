import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildResponseMap } from '../screenshots/replay.mjs';

const fixture = JSON.parse(await readFile(new URL('../screenshots/captures/screenshots.json', import.meta.url), 'utf8'));

test('documentation capture contains an authenticated installation and a redacted CSRF response', () => {
    const records = [...buildResponseMap(fixture).values()];
    assert.equal(records.find(record => record.request.path === '/auth/csrf').response.body.csrfToken, 'offline-preview-context');
    assert.equal(records.find(record => record.request.path === '/settings').response.body.firstTimeRun, false);
    assert(!JSON.stringify(records).includes('set-cookie'));
});

test('legacy disabled-auth and logged-out snapshots cannot silently produce login screenshots', () => {
    for (const body of [{ authEnabled: false }, { authEnabled: true, authenticated: false, setupRequired: false }]) {
        const stale = structuredClone(fixture);
        stale.scenarios[0].requests.find(record => record.request.path === '/auth/status').response.body = body;
        assert.throws(() => buildResponseMap(stale), /lacks an authenticated administrator/);
    }
});

test('live CSRF secrets cannot be accepted as offline replay data', () => {
    const unsafe = structuredClone(fixture);
    unsafe.csrfContext.record.response.body.csrfToken = 'unredacted';
    assert.throws(() => buildResponseMap(unsafe), /unredacted CSRF/);
});
