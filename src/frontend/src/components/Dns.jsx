/* eslint-disable i18next/no-literal-string -- Fork feature (DNS.md): English-only by design, so the fork touches upstream's fast-moving locale files with two keys only */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch, API } from "../utils/api.js";
import { localizeError } from "../utils/errorMessages.js";

// Cloudflare DNS for every account in the mounted accounts file. Cloudflare is
// the source of truth: the table is a fresh read, every write is staged, then
// previewed (live re-read; a record edited elsewhere since it was staged is
// refused), then applied — with the before-state saved as a snapshot first.

const EDITABLE = ["A", "AAAA", "CNAME", "TXT", "MX"];
const PROXIABLE = ["A", "AAAA", "CNAME"];
const PRESETS = {
    all: { label: "All", test: () => true },
    zero: { label: "0.0.0.0", test: r => r.content === "0.0.0.0" },
    private: { label: "Private IPs", test: r => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(r.content) },
    proxied: { label: "Proxied", test: r => r.proxied },
    direct: { label: "Not proxied", test: r => r.proxiable && !r.proxied },
};
const EMPTY_FORM = { type: "A", name: "", content: "", ttl: 1, proxied: false, priority: 10, comment: "" };

function recordKey(r) { return `${r.account}|${r.zoneId}|${r.id}`; }

function bodyFromForm(f) {
    const body = { type: f.type, name: f.name.trim(), content: f.content.trim(), ttl: Number(f.ttl) || 1,
        proxied: PROXIABLE.includes(f.type) ? Boolean(f.proxied) : false, comment: f.comment.trim() || null };
    if (f.type === "MX") body.priority = Number(f.priority);
    return body;
}

function bodyFromRecord(r, overrides = {}) {
    const body = { type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied, comment: r.comment ?? null, ...overrides };
    if (r.type === "MX") body.priority = r.priority;
    return body;
}

function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
}

function toCsv(rows) {
    const cols = ["account", "zone", "type", "name", "content", "ttl", "proxied", "priority", "comment", "id"];
    const cell = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n") + "\n";
}

function describe(change) {
    const a = change.after;
    if (change.op === "create") return `+ ${a.type} ${a.name} → ${a.content}`;
    if (change.op === "delete") return `− ${change.label}`;
    return `~ ${change.label} ⇒ ${a.content}${a.proxied ? " (proxied)" : ""}`;
}

export default function Dns({ toast, onUnauth }) {
    const { t } = useTranslation();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState("");
    const [type, setType] = useState("");
    const [zone, setZone] = useState("");
    const [preset, setPreset] = useState("all");
    const [selected, setSelected] = useState(new Set());
    const [staged, setStaged] = useState([]);
    const [previewed, setPreviewed] = useState(null);
    const [results, setResults] = useState(null);
    const [snapshots, setSnapshots] = useState([]);
    const [form, setForm] = useState(null);           // null = closed; {editing?: record}
    const [repoint, setRepoint] = useState("");
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(null);       // {done, total} while an apply job runs

    const fail = useCallback(err => toast.error(localizeError(err, t), err), [toast, t]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [inv, snaps] = await Promise.all([apiFetch("/dns/records", {}, onUnauth), apiFetch("/dns/snapshots", {}, onUnauth)]);
            setData(inv);
            setSnapshots(snaps);
            setSelected(new Set());
        } catch (err) { fail(err); } finally { setLoading(false); }
    }, [onUnauth, fail]);

    useEffect(() => { load(); }, [load]);

    const zones = useMemo(() => (data?.accounts || []).flatMap(a => a.zones.map(z => ({ ...z, account: a.name }))), [data]);
    const rows = useMemo(() => {
        const q = search.trim().toLowerCase();
        return (data?.records || []).filter(r =>
            (!q || r.name.toLowerCase().includes(q) || r.content.toLowerCase().includes(q) || (r.comment || "").toLowerCase().includes(q))
            && (!type || r.type === type)
            && (!zone || `${r.account}|${r.zoneId}` === zone)
            && PRESETS[preset].test(r));
    }, [data, search, type, zone, preset]);
    const selectedRows = rows.filter(r => selected.has(recordKey(r)));
    const types = useMemo(() => [...new Set((data?.records || []).map(r => r.type))].sort(), [data]);

    function stage(changes) {
        setStaged(prev => [...prev, ...changes]);
        setPreviewed(null);
        setResults(null);
    }

    function toggle(r) {
        setSelected(prev => { const next = new Set(prev); next.has(recordKey(r)) ? next.delete(recordKey(r)) : next.add(recordKey(r)); return next; });
    }

    function stageRepoint() {
        const target = repoint.trim();
        if (!target) return;
        const editable = selectedRows.filter(r => EDITABLE.includes(r.type));
        stage(editable.map(r => ({ op: "update", account: r.account, zoneId: r.zoneId, recordId: r.id, before: { modified_on: r.modified_on },
            after: bodyFromRecord(r, { content: target }), label: `${r.type} ${r.name} (${r.content})` })));
        if (editable.length < selectedRows.length) toast.info(`${selectedRows.length - editable.length} record(s) skipped: only ${EDITABLE.join(", ")} can be edited here`);
        setRepoint("");
    }

    function stageDeletes() {
        stage(selectedRows.map(r => ({ op: "delete", account: r.account, zoneId: r.zoneId, recordId: r.id, before: { modified_on: r.modified_on }, label: `${r.type} ${r.name} (${r.content})` })));
    }

    function submitForm(e) {
        e.preventDefault();
        if (form.editing) {
            const r = form.editing;
            stage([{ op: "update", account: r.account, zoneId: r.zoneId, recordId: r.id, before: { modified_on: r.modified_on }, after: bodyFromForm(form), label: `${r.type} ${r.name} (${r.content})` }]);
        } else {
            const [account, zoneId] = form.zoneKey.split("|");
            stage([{ op: "create", account, zoneId, after: bodyFromForm(form) }]);
        }
        setForm(null);
    }

    const wire = changes => changes.map(({ label, ...c }) => c);   // eslint-disable-line no-unused-vars

    async function runPreview() {
        setBusy(true);
        try {
            const res = await apiFetch("/dns/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes: wire(staged) }) }, onUnauth);
            setPreviewed(res.changes);
        } catch (err) { fail(err); } finally { setBusy(false); }
    }

    // Apply runs as a server-side job (it can outlast any HTTP request); poll it.
    async function runApply() {
        setBusy(true);
        try {
            const { jobId, total } = await apiFetch("/dns/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes: wire(staged) }) }, onUnauth);
            setProgress({ done: 0, total });
            let job;
            for (;;) {
                await new Promise(r => setTimeout(r, 1000));
                job = await apiFetch(`/dns/jobs/${jobId}`, {}, onUnauth);
                setProgress({ done: job.done, total: job.total });
                if (job.state !== "running") break;
            }
            setProgress(null);
            if (job.state === "failed") throw new Error(job.error?.errors?.map(e => e.message).join("; ") || "apply failed");
            const res = job.result;
            setResults(res);
            setStaged([]);
            setPreviewed(null);
            const applied = res.results.filter(r => r.status === "applied").length;
            toast.success(`Applied ${applied} of ${res.results.length}. Snapshot ${res.snapshotId}`);
            await load();
        } catch (err) { fail(err); } finally { setBusy(false); setProgress(null); }
    }

    async function loadRevert(id) {
        try {
            const res = await apiFetch(`/dns/snapshots/${encodeURIComponent(id)}/revert-plan`, { method: "POST" }, onUnauth);
            stage(res.changes.map(c => ({ ...c, label: `revert ${id}: ${c.after?.name || c.recordId}` })));
        } catch (err) { fail(err); }
    }

    function exportBind() {
        const list = zone ? [zone] : zones.map(z => `${z.account}|${z.id}`);
        if (!list.length) return;
        const param = list.map(k => k.replace("|", ":")).join(",");
        window.open(`${API}/dns/export/bind?zones=${encodeURIComponent(param)}`, "_blank", "noopener");
    }

    const exportRows = selectedRows.length ? selectedRows : rows;
    const okCount = previewed ? previewed.filter(c => c.status === "ok").length : 0;

    if (!data) return <div className="loading">{t("common.loading")}</div>;

    if (!data.accounts.length) {
        return (
            <div className="card">
                <div className="card-title">Cloudflare DNS</div>
                <p className="hint">No Cloudflare accounts configured. Create <span className="mono">~/.caddy-ui-dns/accounts.json</span> on this machine
                    — <span className="mono">{'[{"name": "main", "token": "…"}]'}</span> — and restart. See DNS.md.</p>
            </div>
        );
    }

    return (
        <div className="gap-16">
            <div className="card">
                <div className="flex-between">
                    <div className="card-title">Cloudflare DNS — {data.records.length} records</div>
                    <div className="btn-row">
                        <button className="btn btn-ghost btn--sm" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
                        <button className="btn btn-primary btn--sm" onClick={() => setForm({ ...EMPTY_FORM, zoneKey: zone || (zones[0] ? `${zones[0].account}|${zones[0].id}` : "") })}>Add record</button>
                    </div>
                </div>
                <div className="btn-row">
                    {data.accounts.map(a => (
                        <span key={a.name} className={`badge ${a.status === "active" ? "badge-green" : "badge-red"}`} title={a.error ? JSON.stringify(a.error) : ""}>
                            {a.name}: {a.status}{a.status === "active" ? ` · ${a.zones.length} zone(s)` : ""}
                        </span>
                    ))}
                </div>
            </div>

            {form && (
                <form className="card" onSubmit={submitForm}>
                    <div className="card-title">{form.editing ? `Edit ${form.editing.type} ${form.editing.name}` : "Add record"}</div>
                    <div className="config-grid">
                        {!form.editing && (
                            <label className="field"><span className="field-label">Zone</span>
                                <select className="config-select" value={form.zoneKey} onChange={e => setForm({ ...form, zoneKey: e.target.value })} required>
                                    {zones.map(z => <option key={`${z.account}|${z.id}`} value={`${z.account}|${z.id}`}>{z.name} ({z.account})</option>)}
                                </select></label>
                        )}
                        <label className="field"><span className="field-label">Type</span>
                            <select className="config-select" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} disabled={Boolean(form.editing)}>
                                {EDITABLE.map(x => <option key={x}>{x}</option>)}
                            </select></label>
                        <label className="field"><span className="field-label">Name</span>
                            <input className="config-input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="sub.example.com" required /></label>
                        <label className="field"><span className="field-label">Content</span>
                            <input className="config-input mono" value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} required /></label>
                        <label className="field"><span className="field-label">TTL (1 = auto)</span>
                            <input className="config-input" type="number" value={form.ttl} onChange={e => setForm({ ...form, ttl: e.target.value })} /></label>
                        {form.type === "MX" && (
                            <label className="field"><span className="field-label">Priority</span>
                                <input className="config-input" type="number" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })} /></label>
                        )}
                        <label className="field"><span className="field-label">Comment</span>
                            <input className="config-input" value={form.comment} onChange={e => setForm({ ...form, comment: e.target.value })} maxLength={100} /></label>
                        {PROXIABLE.includes(form.type) && (
                            <label className="config-checkbox"><input type="checkbox" checked={form.proxied} onChange={e => setForm({ ...form, proxied: e.target.checked })} />
                                <span className="config-checkbox-label">Proxied through Cloudflare</span></label>
                        )}
                    </div>
                    <div className="btn-row">
                        <button className="btn btn-primary btn--sm" type="submit">Stage</button>
                        <button className="btn btn-ghost btn--sm" type="button" onClick={() => setForm(null)}>Cancel</button>
                    </div>
                </form>
            )}

            {staged.length > 0 && (
                <div className="card">
                    <div className="flex-between">
                        <div className="card-title">Staged changes ({staged.length})</div>
                        <div className="btn-row">
                            <button className="btn btn-ghost btn--sm" onClick={() => { setStaged([]); setPreviewed(null); }}>Discard all</button>
                            <button className="btn btn--sm" onClick={runPreview} disabled={busy}>Preview against live</button>
                            <button className="btn btn-primary btn--sm" onClick={runApply} disabled={busy || !previewed || okCount === 0}>
                                {progress ? `Applying ${progress.done}/${progress.total}…` : previewed ? `Apply ${okCount}` : "Preview first"}</button>
                        </div>
                    </div>
                    <p className="hint">Preview re-reads every record from Cloudflare. Anything changed there since you staged it is refused, not overwritten.</p>
                    <ul className="mono">
                        {staged.map((c, i) => {
                            const p = previewed?.[i];
                            return (
                                <li key={i}>
                                    {p && <span className={`badge ${p.status === "ok" ? "badge-green" : "badge-red"}`}>{p.status === "ok" ? "ok" : `refused: ${p.reason}`}</span>}{" "}
                                    {describe(c)}{" "}
                                    <button className="btn btn-ghost btn--sm" onClick={() => { setStaged(staged.filter((_, j) => j !== i)); setPreviewed(null); }}>remove</button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}

            {results && (
                <div className="card">
                    <div className="card-title">Last apply — snapshot <span className="mono">{results.snapshotId}</span></div>
                    <ul className="mono">
                        {results.results.map((r, i) => (
                            <li key={i}><span className={`badge ${r.status === "applied" ? "badge-green" : r.status === "refused" ? "badge-yellow" : "badge-red"}`}>{r.status}</span>{" "}
                                {r.op} {r.name || ""} {r.zone ? `(${r.zone})` : ""} {r.reason || ""} {r.error ? r.error.errors.map(e => `${e.code}: ${e.message}`).join("; ") : ""}</li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="card">
                <div className="btn-row">
                    <div className="search-wrap"><input className="search-input" placeholder="Search name, content, comment" value={search} onChange={e => setSearch(e.target.value)} /></div>
                    <select className="config-select" value={zone} onChange={e => setZone(e.target.value)}>
                        <option value="">All zones</option>
                        {zones.map(z => <option key={`${z.account}|${z.id}`} value={`${z.account}|${z.id}`}>{z.name} ({z.account})</option>)}
                    </select>
                    <select className="config-select" value={type} onChange={e => setType(e.target.value)}>
                        <option value="">All types</option>
                        {types.map(x => <option key={x}>{x}</option>)}
                    </select>
                    {Object.entries(PRESETS).map(([k, p]) => (
                        <button key={k} className={`btn btn--sm ${preset === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setPreset(k)}>{p.label}</button>
                    ))}
                </div>
                <div className="btn-row">
                    <span className="hint">{rows.length} shown · {selectedRows.length} selected</span>
                    <input className="config-input mono" placeholder="new target for selected (IP or hostname)" value={repoint} onChange={e => setRepoint(e.target.value)} />
                    <button className="btn btn--sm" onClick={stageRepoint} disabled={!selectedRows.length || !repoint.trim()}>Stage repoint</button>
                    <button className="btn btn-danger btn--sm" onClick={stageDeletes} disabled={!selectedRows.length}>Stage delete</button>
                    <button className="btn btn-ghost btn--sm" onClick={() => download("dns-records.json", JSON.stringify(exportRows, null, 2) + "\n", "application/json")}>Export JSON</button>
                    <button className="btn btn-ghost btn--sm" onClick={() => download("dns-records.csv", toCsv(exportRows), "text/csv")}>Export CSV</button>
                    <button className="btn btn-ghost btn--sm" onClick={exportBind}>{zone ? "Export zone (BIND)" : "Export all zones (BIND)"}</button>
                </div>
                <div className="table-wrap">
                    <table className="table">
                        <thead><tr>
                            <th><input type="checkbox" checked={rows.length > 0 && selectedRows.length === rows.length}
                                onChange={e => setSelected(e.target.checked ? new Set(rows.map(recordKey)) : new Set())} /></th>
                            <th>Name</th><th>Type</th><th>Content</th><th>Proxied</th><th>TTL</th><th>Zone</th><th></th>
                        </tr></thead>
                        <tbody>
                            {rows.map(r => (
                                <tr key={recordKey(r)}>
                                    <td><input type="checkbox" checked={selected.has(recordKey(r))} onChange={() => toggle(r)} /></td>
                                    <td className="mono">{r.name}</td>
                                    <td>{r.type}{r.type === "MX" ? ` ${r.priority}` : ""}</td>
                                    <td className="mono" title={r.comment || ""}>{r.content}</td>
                                    <td>{r.proxiable ? (r.proxied ? "yes" : "no") : "—"}</td>
                                    <td>{r.ttl === 1 ? "auto" : r.ttl}</td>
                                    <td className="cell-muted">{r.zone} ({r.account})</td>
                                    <td className="cell-actions">
                                        {EDITABLE.includes(r.type) && <button className="btn btn-ghost btn--sm"
                                            onClick={() => setForm({ ...EMPTY_FORM, ...bodyFromRecord(r), comment: r.comment || "", priority: r.priority ?? 10, editing: r })}>edit</button>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="card">
                <div className="card-title">Snapshots (before-state of each apply)</div>
                {snapshots.length === 0 ? <p className="hint">None yet.</p> : (
                    <ul className="mono">
                        {snapshots.map(s => (
                            <li key={s.id}>{s.id} · {s.actor || "?"} · {s.applied} applied, {s.failed} failed, {s.refused} refused{" "}
                                {s.applied > 0 && <button className="btn btn-ghost btn--sm" onClick={() => loadRevert(s.id)}>stage revert</button>}</li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
