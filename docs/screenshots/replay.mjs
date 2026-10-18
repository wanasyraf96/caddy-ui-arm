import { requestKey, validateCapture } from '../../dev/playground/capture-format.js';

// Documentation replays a successfully enrolled installation. It must not
// recreate the retired authentication opt-out or guess missing API responses.
export function buildResponseMap(capture) {
    validateCapture(capture);
    const responses = new Map();
    for (const scenario of capture.scenarios) {
        for (const record of scenario.requests) responses.set(requestKey(record.request), record);
    }
    const auth = responses.get(requestKey({ path: '/auth/status' }));
    if (auth?.response.status !== 200 || auth.response.body?.authEnabled !== true
        || auth.response.body.authenticated !== true || auth.response.body.setupRequired !== false) {
        throw new Error('Screenshot capture lacks an authenticated administrator. Refresh it with npm run docs:screenshots:capture.');
    }
    if (!capture.csrfContext) throw new Error('Screenshot capture lacks a redacted CSRF context. Refresh the capture.');
    responses.set(requestKey(capture.csrfContext.record.request), capture.csrfContext.record);
    return responses;
}
