import { readFile } from 'fs/promises';
import { join } from 'path';
import { AppError } from '../AppError.js';

// Cloudflare accounts for the DNS page, one API token each.
//
// Read from ONE explicit file, CADDY_UI_DNS_DIR/accounts.json, mounted
// read-only on the laptop. Never from CF_* environment variables, never from a
// .env, never by searching: the production dashboard runs this same codebase's
// upstream, and nothing here may pick up a token that happens to be nearby.
//
//   [{ "name": "main", "token": "..." }, { "name": "msca", "token": "..." }]
//
// No file means no accounts — a valid state, the page just shows nothing.
// Tokens never leave this module except to the Cloudflare client: callers get
// account objects built from an allowlist (publicAccount), never a copy of the
// stored object with the token deleted.
export const DNS_DIR = process.env.CADDY_UI_DNS_DIR || '/run/caddy-ui-dns';
const ACCOUNTS_FILE = join(DNS_DIR, 'accounts.json');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,200}$/;
const NAME_PATTERN = /^[A-Za-z0-9 ._-]{1,80}$/;

export async function loadAccounts() {
    let raw;
    try {
        raw = await readFile(ACCOUNTS_FILE, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw new AppError('REQUEST_FAILED', { message: 'DNS accounts file unreadable', context: { file: 'accounts.json', reason: error.code } });
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // Not the parser's message: it can quote the offending text, token included.
        throw new AppError('VALIDATION_FAILED', { message: 'DNS accounts file is not valid JSON', context: { file: 'accounts.json' } });
    }
    if (!Array.isArray(parsed)) {
        throw new AppError('VALIDATION_FAILED', { message: 'DNS accounts file must be a JSON array', context: { file: 'accounts.json' } });
    }
    const seen = new Set();
    return parsed.map((entry, index) => {
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        const token = typeof entry?.token === 'string' ? entry.token.trim() : '';
        if (!NAME_PATTERN.test(name) || seen.has(name)) {
            throw new AppError('VALIDATION_FAILED', { message: 'DNS account name missing, invalid or duplicated', context: { file: 'accounts.json', index } });
        }
        if (!TOKEN_PATTERN.test(token)) {
            throw new AppError('VALIDATION_FAILED', { message: 'DNS account token missing or malformed', context: { file: 'accounts.json', account: name } });
        }
        seen.add(name);
        return { name, token };
    });
}

export function publicAccount(account, extra = {}) {
    return { name: account.name, ...extra };
}

export async function findAccount(name) {
    const account = (await loadAccounts()).find(a => a.name === name);
    if (!account) throw new AppError('VALIDATION_FAILED', { message: 'Unknown DNS account', context: { account: String(name).slice(0, 80) } });
    return account;
}
