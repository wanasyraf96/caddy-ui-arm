import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Harness } from '../../dev/dev-caddy/harness.mjs';
import { captureScreenshots } from './capture.mjs';
import { renderScreenshots } from './screenshot.mjs';

test('real authenticated documentation capture renders all views and rejects missing API data', { timeout: 240000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'caddy-docs-check-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const capturePath = join(directory, 'capture.json');
    const outputDirectory = join(directory, 'images');
    let harness;
    const capture = await captureScreenshots({ output: capturePath, onNamespace: project => { harness = new Harness(project); } });
    assert.deepEqual(await harness.names(), []);
    assert.deepEqual(await harness.names('volume'), []);
    const records = capture.scenarios[0].requests;
    assert.equal(records.find(record => record.request.path === '/auth/status').response.body.authenticated, true);
    assert.equal(records.find(record => record.request.path === '/route-notes').response.body['homeassistant.internal'], 'Home Assistant');
    assert(Object.values(records.find(record => record.request.path === '/health/uptime').response.body).every(stats => stats.pct === 100));
    assert.equal(records.find(record => record.request.path === '/status').response.body.upstreamsOnline, 3);
    assert.equal(capture.csrfContext.record.response.body.csrfToken, 'offline-preview-context');
    const serialized = await readFile(capturePath, 'utf8');
    assert(!serialized.includes('set-cookie'));
    assert(!serialized.includes('recoveryKey'));
    const views = await renderScreenshots({ capturePath, outputDirectory });
    assert.equal(views.length, 8);
    for (const view of views) assert((await stat(join(outputDirectory, view + '.png'))).size > 1000);

    capture.scenarios[0].requests = records.filter(record => record.request.path !== '/settings');
    await writeFile(capturePath, JSON.stringify(capture));
    const rejectedOutput = join(directory, 'rejected');
    await assert.rejects(renderScreenshots({ capturePath, outputDirectory: rejectedOutput }), /Unrecorded|unrecorded/);
    assert.deepEqual(await readdir(rejectedOutput), [], 'A missing response must not publish an error screenshot');
});
