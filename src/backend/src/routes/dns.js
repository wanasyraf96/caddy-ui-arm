import { Router } from 'express';
import { AppError, asAppError } from '../AppError.js';
import { sendAppError } from '../errorReporting.js';
import logger from '../logger.js';
import { getAuthentication } from '../middleware/auth.js';
import { exportBind, getJob, inventory, listSnapshots, preview, revertPlan, startApply } from '../dns/service.js';

// Cloudflare DNS management (fork feature; see DNS.md). Mounted with
// authMiddleware and outside the instance middleware, so it works with zero
// Caddy instances. Session-only: API tokens cannot reach it (apiTokenPolicy).
const router = Router();

function fail(res, error, context) {
    // Only AppErrors cross the boundary; their messages and context are built
    // from safe fields in dns/, never from a raw upstream error.
    return sendAppError(res, error instanceof AppError ? error : asAppError(new Error('DNS request failed'), 'REQUEST_FAILED', context));
}

// GET /api/dns/records -- every record of every zone of every account
router.get('/records', async (req, res) => {
    try { res.json(await inventory()); } catch (error) { fail(res, error, { op: 'inventory' }); }
});

// POST /api/dns/preview {changes} -- re-reads live records; nothing is written
router.post('/preview', async (req, res) => {
    try { res.json({ changes: await preview(req.body?.changes) }); } catch (error) { fail(res, error, { op: 'preview' }); }
});

// POST /api/dns/apply {changes} -> 202 {jobId}. Previews again, snapshots,
// applies — in the background, because it can outlast any HTTP request.
router.post('/apply', async (req, res) => {
    try {
        const actor = getAuthentication().getActor(req);
        const job = startApply(req.body?.changes, { actor });
        job.promise.then(() => {
            if (job.state !== 'done') return;
            const count = s => job.result.results.filter(r => r.status === s).length;
            logger.info('DNS changes applied', { snapshotId: job.result.snapshotId, applied: count('applied'), failed: count('failed'), refused: count('refused') });
        });
        res.status(202).json({ jobId: job.id, total: job.total });
    } catch (error) { fail(res, error, { op: 'apply' }); }
});

// GET /api/dns/jobs/:id -- progress, then the per-record results
router.get('/jobs/:id', (req, res) => {
    const job = /^[a-f0-9]{16}$/.test(req.params.id) ? getJob(req.params.id) : null;
    if (!job) return fail(res, new AppError('VALIDATION_FAILED', { message: 'unknown job' }), { op: 'job' });
    res.json(job);
});

// GET /api/dns/snapshots -- most recent first
router.get('/snapshots', async (req, res) => {
    try { res.json(await listSnapshots()); } catch (error) { fail(res, error, { op: 'snapshots' }); }
});

// POST /api/dns/snapshots/:id/revert-plan -- a change list to preview/apply
router.post('/snapshots/:id/revert-plan', async (req, res) => {
    try { res.json({ changes: await revertPlan(req.params.id) }); } catch (error) { fail(res, error, { op: 'revert-plan' }); }
});

// GET /api/dns/export/bind?zones=account:zoneId,account:zoneId
router.get('/export/bind', async (req, res) => {
    try {
        const zones = String(req.query.zones || '').split(',').filter(Boolean).map(pair => {
            const at = pair.lastIndexOf(':');
            return { account: pair.slice(0, at), zoneId: pair.slice(at + 1) };
        });
        if (!zones.length) throw new AppError('VALIDATION_FAILED', { message: 'zones required' });
        const text = await exportBind(zones);
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="dns-export.zone"');
        res.set('Cache-Control', 'no-store');
        res.send(text);
    } catch (error) { fail(res, error, { op: 'export' }); }
});

export default router;
