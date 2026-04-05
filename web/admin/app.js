import React, { useEffect, useState, useCallback } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const BASE = location.origin;
const STRATEGIES = ["round-robin", "quota-first", "scheduled", "custom"];
const PROVIDERS = ["anthropic", "openai-codex", "github-copilot", "google-gemini-cli", "google-antigravity"];

async function api(path, init) {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  return r.json();
}
function jpost(data) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }; }
function jput(data) { return { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }; }

function ago(ts) {
  if (!ts) return "--";
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60e3) return `${Math.round(ms / 1e3)}s ago`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)}m ago`;
  return `${Math.round(ms / 36e5)}h ago`;
}
function qColor(s) { return s == null ? "#3f3f46" : s > 50 ? "#22c55e" : s > 20 ? "#eab308" : "#ef4444"; }
function QuotaBar({ score }) { return html`<span className="q-bar"><span className="q-fill" style=${{ width: `${score ?? 0}%`, background: qColor(score) }} /></span>`; }

// ════════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════════════════

function DashboardPanel({ data }) {
  const session = data?.stats?.session || {};
  const providers = data?.stats?.providers || [];
  const recent = data?.stats?.recent || [];
  const quotaProviders = data?.quota?.providers || [];
  const exhausted = new Set(data?.health?.exhausted || []);

  return html`<div>
    <h2>Session</h2>
    <div className="stat-grid">
      <div className="stat"><div className="stat-num">${session.total_requests || 0}</div><div className="stat-label">Requests</div></div>
      <div className="stat"><div className="stat-num">${session.total_tokens_in || 0}</div><div className="stat-label">Tokens in</div></div>
      <div className="stat"><div className="stat-num">${session.total_tokens_out || 0}</div><div className="stat-label">Tokens out</div></div>
      <div className="stat"><div className="stat-num">${session.total_errors || 0}</div><div className="stat-label">Errors</div></div>
    </div>
    <h2 className="mt">Providers</h2>
    <div className="table-wrap"><table>
      <thead><tr><th>Provider</th><th>Quota</th><th>Status</th><th>Requests</th><th>Tokens</th><th>Last used</th></tr></thead>
      <tbody>${quotaProviders.map((p) => {
        const ps = providers.find((x) => x.provider === p.provider) || {};
        return html`<tr key=${p.provider}><td style=${{ color: "#fafafa", fontWeight: 500 }}>${p.label || p.provider}</td><td><${QuotaBar} score=${p.score} /> <span style=${{ color: qColor(p.score) }}>${p.score == null ? "?" : `${p.score}%`}</span></td><td>${exhausted.has(p.provider) ? html`<span className="badge off">exhausted</span>` : html`<span className="badge on">${p.status || "ok"}</span>`}</td><td>${ps.requests || 0}</td><td>${ps.tokens_in || 0} / ${ps.tokens_out || 0}</td><td>${ago(ps.last_used)}</td></tr>`;
      })}</tbody>
    </table></div>
    <h2 className="mt">Recent chats</h2>
    <div className="table-wrap"><table>
      <thead><tr><th>Time</th><th>Provider</th><th>Model</th><th>Tokens</th><th>Duration</th><th>Error</th><th>Request</th><th>Response</th></tr></thead>
      <tbody>${recent.length === 0 ? html`<tr><td colSpan="8" className="empty">No requests yet.</td></tr>` : recent.slice(0, 50).map((r, i) => html`<tr key=${i}><td>${ago(r.timestamp)}</td><td>${r.provider}</td><td style=${{ fontFamily: "monospace", fontSize: "11px" }}>${r.model}</td><td>${r.tokens_in} / ${r.tokens_out}</td><td>${r.duration_ms}ms</td><td>${r.error ? html`<span style=${{ color: "#ef4444" }}>${r.error}</span>` : "--"}</td><td>${r.request_text ? html`<details><summary>${r.request_text.slice(0, 40)}...</summary><pre>${r.request_text}</pre></details>` : "--"}</td><td>${r.response_text ? html`<details><summary>${r.response_text.slice(0, 40)}...</summary><pre>${r.response_text}</pre></details>` : "--"}</td></tr>`)}</tbody>
    </table></div>
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// CONFIG EDITOR
// ════════════════════════════════════════════════════════════════════════════════

function InlineEdit({ value, onChange, placeholder, mono }) {
  return html`<input className=${mono ? "mono" : ""} value=${value || ""} onInput=${(e) => onChange(e.target.value)} placeholder=${placeholder} />`;
}

function TagList({ items, onChange, placeholder }) {
  const [draft, setDraft] = useState("");
  function add() { if (draft.trim()) { onChange([...items, draft.trim()]); setDraft(""); } }
  function remove(i) { onChange(items.filter((_, idx) => idx !== i)); }
  return html`
    <div>
      <div style=${{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "6px" }}>
        ${items.map((item, i) => html`<span key=${i} className="badge neutral" style=${{ cursor: "pointer" }} onClick=${() => remove(i)}>${item} x</span>`)}
      </div>
      <div style=${{ display: "flex", gap: "6px" }}>
        <input value=${draft} onInput=${(e) => setDraft(e.target.value)} placeholder=${placeholder} onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} style=${{ flex: 1 }} />
        <button className="btn" onClick=${add}>+</button>
      </div>
    </div>
  `;
}

// ── Subscriptions ──

function SubEditor({ subs, onSave }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});

  function startEdit(s) { setEditing(s.name); setDraft({ ...s }); }
  function startNew() { setEditing("__new__"); setDraft({ name: "", provider: PROVIDERS[0], enabled: true, alias: "" }); }
  function cancel() { setEditing(null); }
  async function save() {
    if (editing === "__new__") {
      await api("/v1/config/subscriptions", jpost(draft));
    } else {
      await api(`/v1/config/subscriptions/${encodeURIComponent(editing)}`, jput(draft));
    }
    setEditing(null);
    onSave();
  }
  async function del(name) { if (confirm(`Delete subscription "${name}"?`)) { await api(`/v1/config/subscriptions/${encodeURIComponent(name)}`, { method: "DELETE" }); onSave(); } }

  return html`<div>
    <div className="card-row" style=${{ marginBottom: "10px" }}><h2 style=${{ margin: 0 }}>Subscriptions</h2><button className="btn primary" onClick=${startNew}>+ Add</button></div>
    ${subs.map((s) => editing === s.name ? html`
      <div className="card" key=${s.name}>
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div><label>Provider</label><select value=${draft.provider} onChange=${(e) => setDraft({ ...draft, provider: e.target.value })}>${PROVIDERS.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}</select></div>
          <div><label>Alias</label><input value=${draft.alias || ""} onInput=${(e) => setDraft({ ...draft, alias: e.target.value })} /></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
        <div className="actions" style=${{ marginTop: "10px" }}><button className="btn primary" onClick=${save}>Save</button><button className="btn" onClick=${cancel}>Cancel</button></div>
      </div>
    ` : html`
      <div className="card" key=${s.name}>
        <div className="card-row">
          <div><span className="name">${s.name}</span><span className="badge neutral">${s.provider}</span><span className=${`badge ${s.enabled !== false ? "on" : "off"}`}>${s.enabled !== false ? "on" : "off"}</span>${s.alias ? html`<span className="badge neutral">${s.alias}</span>` : null}</div>
          <div className="actions"><button className="btn" onClick=${() => startEdit(s)}>Edit</button><button className="btn danger" onClick=${() => del(s.name)}>Del</button></div>
        </div>
      </div>
    `)}
    ${editing === "__new__" ? html`
      <div className="card">
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. openai-codex-2" /></div>
          <div><label>Provider</label><select value=${draft.provider} onChange=${(e) => setDraft({ ...draft, provider: e.target.value })}>${PROVIDERS.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}</select></div>
          <div><label>Alias</label><input value=${draft.alias} onInput=${(e) => setDraft({ ...draft, alias: e.target.value })} /></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
        <div className="actions" style=${{ marginTop: "10px" }}><button className="btn primary" onClick=${save}>Create</button><button className="btn" onClick=${cancel}>Cancel</button></div>
      </div>
    ` : null}
  </div>`;
}

// ── Pools ──

function PoolEditor({ pools, onSave }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});

  function startEdit(p) { setEditing(p.name); setDraft({ ...p, members: [...(p.members || [])] }); }
  function startNew() { setEditing("__new__"); setDraft({ name: "", enabled: true, baseProvider: PROVIDERS[0], members: [], strategy: "round-robin" }); }
  function cancel() { setEditing(null); }
  async function save() {
    if (editing === "__new__") { await api("/v1/config/pools", jpost(draft)); }
    else { await api(`/v1/config/pools/${encodeURIComponent(editing)}`, jput(draft)); }
    setEditing(null); onSave();
  }
  async function del(name) { if (confirm(`Delete pool "${name}"?`)) { await api(`/v1/config/pools/${encodeURIComponent(name)}`, { method: "DELETE" }); onSave(); } }

  function renderForm(isNew) {
    return html`
      <div className="card">
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. codex-pool" /></div>
          <div><label>Base Provider</label><select value=${draft.baseProvider} onChange=${(e) => setDraft({ ...draft, baseProvider: e.target.value })}>${PROVIDERS.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}</select></div>
          <div><label>Strategy</label><select value=${draft.strategy} onChange=${(e) => setDraft({ ...draft, strategy: e.target.value })}>${STRATEGIES.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}</select></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
          <div className="full"><label>Members</label><${TagList} items=${draft.members} onChange=${(m) => setDraft({ ...draft, members: m })} placeholder="Add member name..." /></div>
          ${draft.strategy === "scheduled" ? html`<div className="full"><label>Schedule (JSON)</label><textarea value=${JSON.stringify(draft.memberSchedule || {}, null, 2)} onInput=${(e) => { try { setDraft({ ...draft, memberSchedule: JSON.parse(e.target.value) }); } catch {} }} rows="4" /></div>` : null}
          ${draft.strategy === "custom" ? html`<div className="full"><label>Selector Script Path</label><input value=${draft.selectorScript || ""} onInput=${(e) => setDraft({ ...draft, selectorScript: e.target.value })} placeholder="./my-selector.js" /></div>` : null}
        </div>
        <div className="actions" style=${{ marginTop: "10px" }}><button className="btn primary" onClick=${save}>${isNew ? "Create" : "Save"}</button><button className="btn" onClick=${cancel}>Cancel</button></div>
      </div>
    `;
  }

  return html`<div>
    <div className="card-row" style=${{ marginBottom: "10px" }}><h2 style=${{ margin: 0 }}>Pools</h2><button className="btn primary" onClick=${startNew}>+ Add</button></div>
    ${pools.map((p) => editing === p.name ? renderForm(false) : html`
      <div className="card" key=${p.name}>
        <div className="card-row">
          <div><span className="name">${p.name}</span><span className="badge neutral">${p.strategy || "round-robin"}</span><span className=${`badge ${p.enabled !== false ? "on" : "off"}`}>${p.enabled !== false ? "on" : "off"}</span></div>
          <div className="actions"><button className="btn" onClick=${() => startEdit(p)}>Edit</button><button className="btn danger" onClick=${() => del(p.name)}>Del</button></div>
        </div>
        <div className="meta">Base: ${p.baseProvider} | Members: ${(p.members || []).join(", ") || "none"}</div>
      </div>
    `)}
    ${editing === "__new__" ? renderForm(true) : null}
  </div>`;
}

// ── Chains ──

function ChainEditor({ chains, onSave }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});

  function startEdit(c) { setEditing(c.name); setDraft({ ...c, steps: [...(c.steps || [])] }); }
  function startNew() { setEditing("__new__"); setDraft({ name: "", enabled: true, steps: [] }); }
  function cancel() { setEditing(null); }
  async function save() {
    if (editing === "__new__") { await api("/v1/config/chains", jpost(draft)); }
    else { await api(`/v1/config/chains/${encodeURIComponent(editing)}`, jput(draft)); }
    setEditing(null); onSave();
  }
  async function del(name) { if (confirm(`Delete chain "${name}"?`)) { await api(`/v1/config/chains/${encodeURIComponent(name)}`, { method: "DELETE" }); onSave(); } }

  function updateStep(i, field, value) {
    const steps = [...draft.steps];
    steps[i] = { ...steps[i], [field]: value };
    setDraft({ ...draft, steps });
  }
  function addStep() { setDraft({ ...draft, steps: [...draft.steps, { provider: "", model: "", enabled: true }] }); }
  function removeStep(i) { setDraft({ ...draft, steps: draft.steps.filter((_, idx) => idx !== i) }); }

  function renderForm(isNew) {
    return html`
      <div className="card">
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. premium-fallback" /></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
        <div style=${{ marginTop: "10px" }}>
          <label>Steps (in order)</label>
          ${draft.steps.map((s, i) => html`
            <div key=${i} style=${{ display: "flex", gap: "6px", marginBottom: "6px", alignItems: "center" }}>
              <span style=${{ color: "#52525b", fontSize: "11px", width: "20px" }}>${i + 1}.</span>
              <input value=${s.provider || ""} onInput=${(e) => updateStep(i, "provider", e.target.value)} placeholder="provider or pool:name" style=${{ flex: 1 }} />
              <input value=${s.model || ""} onInput=${(e) => updateStep(i, "model", e.target.value)} placeholder="model (optional)" style=${{ flex: 1 }} />
              <button className="btn danger" onClick=${() => removeStep(i)} style=${{ padding: "4px 8px" }}>x</button>
            </div>
          `)}
          <button className="btn" onClick=${addStep}>+ Add step</button>
        </div>
        <div className="actions" style=${{ marginTop: "10px" }}><button className="btn primary" onClick=${save}>${isNew ? "Create" : "Save"}</button><button className="btn" onClick=${cancel}>Cancel</button></div>
      </div>
    `;
  }

  return html`<div>
    <div className="card-row" style=${{ marginBottom: "10px" }}><h2 style=${{ margin: 0 }}>Chains</h2><button className="btn primary" onClick=${startNew}>+ Add</button></div>
    ${chains.map((c) => editing === c.name ? renderForm(false) : html`
      <div className="card" key=${c.name}>
        <div className="card-row">
          <div><span className="name">${c.name}</span><span className=${`badge ${c.enabled !== false ? "on" : "off"}`}>${c.enabled !== false ? "on" : "off"}</span><span className="badge neutral">${(c.steps || []).length} steps</span></div>
          <div className="actions"><button className="btn" onClick=${() => startEdit(c)}>Edit</button><button className="btn danger" onClick=${() => del(c.name)}>Del</button></div>
        </div>
        <div className="meta">${(c.steps || []).map((s) => `${s.provider}${s.model ? "/" + s.model : ""}`).join(" -> ") || "no steps"}</div>
      </div>
    `)}
    ${editing === "__new__" ? renderForm(true) : null}
  </div>`;
}

// ── Presets ──

function PresetEditor({ presets, onSave }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});

  function startEdit(p) { setEditing(p.name); setDraft({ ...p, entries: [...(p.entries || [])] }); }
  function startNew() { setEditing("__new__"); setDraft({ name: "", enabled: true, entries: [] }); }
  function cancel() { setEditing(null); }
  async function save() {
    if (editing === "__new__") { await api("/v1/config/presets", jpost(draft)); }
    else { await api(`/v1/config/presets/${encodeURIComponent(editing)}`, jput(draft)); }
    setEditing(null); onSave();
  }
  async function del(name) { if (confirm(`Delete preset "${name}"?`)) { await api(`/v1/config/presets/${encodeURIComponent(name)}`, { method: "DELETE" }); onSave(); } }

  function updateEntry(i, field, value) {
    const entries = [...draft.entries];
    entries[i] = { ...entries[i], [field]: field === "enabled" ? value === "true" : value };
    setDraft({ ...draft, entries });
  }
  function addEntry() { setDraft({ ...draft, entries: [...draft.entries, { provider: "", model: "", enabled: true }] }); }
  function removeEntry(i) { setDraft({ ...draft, entries: draft.entries.filter((_, idx) => idx !== i) }); }

  function renderForm(isNew) {
    return html`
      <div className="card">
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. coding-premium" /></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
        <div style=${{ marginTop: "10px" }}>
          <label>Entries (failover order)</label>
          ${draft.entries.map((e, i) => html`
            <div key=${i} style=${{ display: "flex", gap: "6px", marginBottom: "6px", alignItems: "center" }}>
              <span style=${{ color: "#52525b", fontSize: "11px", width: "20px" }}>${i + 1}.</span>
              <input value=${e.provider || ""} onInput=${(ev) => updateEntry(i, "provider", ev.target.value)} placeholder="provider or pool:name" style=${{ flex: 1 }} />
              <input value=${e.model || ""} onInput=${(ev) => updateEntry(i, "model", ev.target.value)} placeholder="model" style=${{ flex: 1 }} />
              <select value=${String(e.enabled !== false)} onChange=${(ev) => updateEntry(i, "enabled", ev.target.value)} style=${{ width: "70px" }}><option value="true">On</option><option value="false">Off</option></select>
              <button className="btn danger" onClick=${() => removeEntry(i)} style=${{ padding: "4px 8px" }}>x</button>
            </div>
          `)}
          <button className="btn" onClick=${addEntry}>+ Add entry</button>
        </div>
        <div className="actions" style=${{ marginTop: "10px" }}><button className="btn primary" onClick=${save}>${isNew ? "Create" : "Save"}</button><button className="btn" onClick=${cancel}>Cancel</button></div>
      </div>
    `;
  }

  return html`<div>
    <div className="card-row" style=${{ marginBottom: "10px" }}><h2 style=${{ margin: 0 }}>Presets</h2><button className="btn primary" onClick=${startNew}>+ Add</button></div>
    ${presets.map((p) => editing === p.name ? renderForm(false) : html`
      <div className="card" key=${p.name}>
        <div className="card-row">
          <div><span className="name">${p.name}</span><span className=${`badge ${p.enabled !== false ? "on" : "off"}`}>${p.enabled !== false ? "on" : "off"}</span><span className="badge neutral">${(p.entries || []).length} entries</span></div>
          <div className="actions"><button className="btn" onClick=${() => startEdit(p)}>Edit</button><button className="btn danger" onClick=${() => del(p.name)}>Del</button></div>
        </div>
        <div className="meta">${(p.entries || []).filter((e) => e.enabled !== false).map((e) => `${e.provider}/${e.model}`).join(" -> ") || "no entries"}</div>
      </div>
    `)}
    ${editing === "__new__" ? renderForm(true) : null}
  </div>`;
}

// ── Auth / OAuth ──

function AuthPanel({ onRefresh }) {
  const [providers, setProviders] = useState([]);
  const [busy, setBusy] = useState({});
  const [polling, setPolling] = useState({});

  async function loadProviders() {
    try { const d = await api("/v1/auth/providers"); setProviders(d.providers || []); } catch {}
  }
  useEffect(() => { loadProviders(); }, []);

  async function startLogin(providerId) {
    setBusy((b) => ({ ...b, [providerId]: "connecting..." }));
    try {
      const res = await api(`/v1/auth/login/${encodeURIComponent(providerId)}`, { method: "POST" });
      if (res.authUrl) {
        window.open(res.authUrl, "_blank");
        setBusy((b) => ({ ...b, [providerId]: "waiting for browser..." }));
        // Poll for completion
        setPolling((p) => ({ ...p, [providerId]: true }));
        pollLogin(providerId);
      }
    } catch (e) {
      setBusy((b) => ({ ...b, [providerId]: `error: ${e.message}` }));
      setTimeout(() => setBusy((b) => { const n = { ...b }; delete n[providerId]; return n; }), 3000);
    }
  }

  async function pollLogin(providerId) {
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const s = await api(`/v1/auth/login/${encodeURIComponent(providerId)}`);
        if (s.status === "authenticated" || s.hasAuth) {
          setBusy((b) => { const n = { ...b }; delete n[providerId]; return n; });
          setPolling((p) => { const n = { ...p }; delete n[providerId]; return n; });
          await loadProviders();
          if (onRefresh) onRefresh();
          return;
        }
      } catch {}
    }
    setBusy((b) => ({ ...b, [providerId]: "timed out" }));
    setPolling((p) => { const n = { ...p }; delete n[providerId]; return n; });
  }

  async function logout(providerId) {
    if (!confirm(`Logout from ${providerId}?`)) return;
    try {
      await api(`/v1/auth/logout/${encodeURIComponent(providerId)}`, { method: "POST" });
      await loadProviders();
      if (onRefresh) onRefresh();
    } catch {}
  }

  return html`<div>
    <h2>OAuth accounts</h2>
    <div style=${{ marginBottom: "10px", fontSize: "11px", color: "#52525b" }}>Login to providers to enable routing. OAuth tokens stored in ~/.pi/agent/auth.json</div>
    ${providers.map((p) => html`
      <div className="card" key=${p.id}>
        <div className="card-row">
          <div>
            <span className="name">${p.name}</span>
            <span className="badge neutral" style=${{ fontFamily: "monospace" }}>${p.id}</span>
            <span className=${`badge ${p.authenticated ? "on" : "off"}`}>${p.authenticated ? "logged in" : "not logged in"}</span>
          </div>
          <div className="actions">
            ${busy[p.id]
              ? html`<span style=${{ fontSize: "12px", color: "#f59e0b" }}>${busy[p.id]}</span>`
              : html`
                ${!p.authenticated ? html`<button className="btn primary" onClick=${() => startLogin(p.id)}>Login</button>` : null}
                ${p.authenticated ? html`<button className="btn danger" onClick=${() => logout(p.id)}>Logout</button>` : null}
              `}
          </div>
        </div>
      </div>
    `)}
    ${providers.length === 0 ? html`<div className="empty">Loading providers...</div>` : null}
  </div>`;
}

function ConfigPanel({ onRefresh }) {
  const [config, setConfig] = useState(null);
  const [err, setErr] = useState("");

  async function load() { setErr(""); try { setConfig(await api("/v1/config")); } catch (e) { setErr(e.message); } }
  useEffect(() => { load(); }, []);

  async function refresh() { await load(); if (onRefresh) onRefresh(); }

  if (!config) return html`<div className="empty">${err || "Loading..."}</div>`;

  return html`<div>
    ${err ? html`<div className="card" style=${{ color: "#ef4444", borderColor: "#7f1d1d" }}>Error: ${err}</div>` : null}
    <${AuthPanel} onRefresh=${refresh} />
    <div style=${{ marginTop: "24px" }} />
    <div style=${{ marginBottom: "6px", fontSize: "11px", color: "#52525b" }}>Editing: ~/.pi/agent/multi-pass.json</div>
    <${SubEditor} subs=${config.subscriptions || []} onSave=${refresh} />
    <div style=${{ marginTop: "20px" }} />
    <${PoolEditor} pools=${config.pools || []} onSave=${refresh} />
    <div style=${{ marginTop: "20px" }} />
    <${ChainEditor} chains=${config.chains || []} onSave=${refresh} />
    <div style=${{ marginTop: "20px" }} />
    <${PresetEditor} presets=${config.presets || []} onSave=${refresh} />
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// RULES
// ════════════════════════════════════════════════════════════════════════════════

function RuleForm({ onCreate, onCancel }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("block");
  const [scope, setScope] = useState("request");
  const [patterns, setPatterns] = useState("");
  const [replacement, setReplacement] = useState("[REDACTED]");
  const [message, setMessage] = useState("");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [maxReq, setMaxReq] = useState("60");
  const [winSec, setWinSec] = useState("60");

  function submit() {
    const rule = { name: name || `rule-${Date.now()}`, type, scope, enabled: true, patterns: patterns.split("\n").map((x) => x.trim()).filter(Boolean), replacement: replacement || undefined, message: message || undefined };
    if (type === "model") { rule.allow = allow.split(",").map((x) => x.trim()).filter(Boolean); rule.deny = deny.split(",").map((x) => x.trim()).filter(Boolean); }
    if (type === "limit") { rule.maxRequests = parseInt(maxReq) || 60; rule.windowSeconds = parseInt(winSec) || 60; }
    onCreate(rule);
  }

  return html`
    <div className="card" style=${{ marginBottom: "16px" }}>
      <div className="form-grid">
        <div><label>Name</label><input value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. block-secrets" /></div>
        <div><label>Type</label><select value=${type} onChange=${(e) => setType(e.target.value)}><option value="block">block</option><option value="redact">redact</option><option value="warn">warn</option><option value="model">model</option><option value="limit">limit</option></select></div>
        <div><label>Scope</label><select value=${scope} onChange=${(e) => setScope(e.target.value)}><option value="request">request</option><option value="response">response</option><option value="both">both</option></select></div>
        ${(type === "block" || type === "redact" || type === "warn") && html`<div className="full"><label>Patterns (regex, one per line)</label><textarea value=${patterns} onInput=${(e) => setPatterns(e.target.value)} placeholder="AKIA[0-9A-Z]{16}" /></div>`}
        ${type === "redact" && html`<div><label>Replacement</label><input value=${replacement} onInput=${(e) => setReplacement(e.target.value)} /></div>`}
        ${(type === "block" || type === "model") && html`<div><label>Block message</label><input value=${message} onInput=${(e) => setMessage(e.target.value)} placeholder="Blocked by policy" /></div>`}
        ${type === "model" && [html`<div key="a"><label>Allow (globs)</label><input value=${allow} onInput=${(e) => setAllow(e.target.value)} placeholder="claude-*, gpt-5*" /></div>`, html`<div key="d"><label>Deny (globs)</label><input value=${deny} onInput=${(e) => setDeny(e.target.value)} placeholder="gpt-4o*" /></div>`]}
        ${type === "limit" && [html`<div key="mr"><label>Max requests</label><input value=${maxReq} onInput=${(e) => setMaxReq(e.target.value)} type="number" /></div>`, html`<div key="ws"><label>Window (seconds)</label><input value=${winSec} onInput=${(e) => setWinSec(e.target.value)} type="number" /></div>`]}
      </div>
      <div className="actions" style=${{ marginTop: "12px" }}><button className="btn primary" onClick=${submit}>Create</button><button className="btn" onClick=${onCancel}>Cancel</button></div>
    </div>
  `;
}

function RulesPanel({ rules, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle(r, enabled) { setBusy(true); try { await api(`/v1/rules/${encodeURIComponent(r.name)}`, jput({ enabled })); await onRefresh(); } finally { setBusy(false); } }
  async function del(r) { if (!confirm(`Delete "${r.name}"?`)) return; setBusy(true); try { await api(`/v1/rules/${encodeURIComponent(r.name)}`, { method: "DELETE" }); await onRefresh(); } finally { setBusy(false); } }
  async function create(payload) { setBusy(true); try { await api("/v1/rules", jpost(payload)); setShowForm(false); await onRefresh(); } finally { setBusy(false); } }

  return html`<div>
    <div style=${{ marginBottom: "6px", fontSize: "11px", color: "#52525b" }}>Stored in: ~/.pi/agent/multi-pass-rules.json</div>
    <div className="card-row" style=${{ marginBottom: "12px" }}>
      <h2 style=${{ margin: 0 }}>Policy rules</h2>
      <div className="actions"><button className="btn" onClick=${onRefresh}>Refresh</button><button className="btn primary" onClick=${() => setShowForm((v) => !v)}>${showForm ? "Close" : "+ Add rule"}</button></div>
    </div>
    ${showForm ? html`<${RuleForm} onCreate=${create} onCancel=${() => setShowForm(false)} />` : null}
    ${rules.length === 0 ? html`<div className="empty">No rules configured.</div>` : null}
    ${rules.map((r) => html`
      <div className="card" key=${r.name}>
        <div className="card-row">
          <div><span className="name">${r.name}</span><span className=${`badge ${r.type}`}>${r.type}</span><span className=${`badge ${r.enabled ? "on" : "off"}`}>${r.enabled ? "on" : "off"}</span><span className="badge neutral">${r.scope || "request"}</span></div>
          <div className="actions"><button className="btn" disabled=${busy} onClick=${() => toggle(r, !r.enabled)}>${r.enabled ? "Disable" : "Enable"}</button><button className="btn danger" disabled=${busy} onClick=${() => del(r)}>Delete</button></div>
        </div>
        <div className="meta">
          ${r.patterns?.length ? `patterns: ${r.patterns.join(", ")}` : ""}
          ${r.allow?.length ? ` | allow: ${r.allow.join(", ")}` : ""}
          ${r.deny?.length ? ` | deny: ${r.deny.join(", ")}` : ""}
          ${r.maxRequests ? ` | ${r.maxRequests} req/${r.windowSeconds}s` : ""}
          ${r.replacement ? ` | replace: ${r.replacement}` : ""}
          ${r.message ? ` | msg: ${r.message}` : ""}
        </div>
      </div>
    `)}
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════════════════

function AuditPanel({ entries, onRefresh }) {
  const [filter, setFilter] = useState("");
  const filtered = filter ? entries.filter((e) => e.rule?.includes(filter) || e.action?.includes(filter) || e.detail?.includes(filter)) : entries;

  return html`<div>
    <div className="card-row" style=${{ marginBottom: "12px" }}>
      <h2 style=${{ margin: 0 }}>Audit log</h2>
      <div className="actions">
        <input value=${filter} onInput=${(e) => setFilter(e.target.value)} placeholder="Filter..." style=${{ width: "160px", padding: "5px 8px", fontSize: "12px" }} />
        <button className="btn" onClick=${onRefresh}>Refresh</button>
      </div>
    </div>
    <div style=${{ marginBottom: "6px", fontSize: "11px", color: "#52525b" }}>Persisted to: ~/.pi/agent/leeloo-audit.jsonl</div>
    ${filtered.length === 0 ? html`<div className="empty">No audit events${filter ? " matching filter" : ""}.</div>` : html`
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Rule</th><th>Type</th><th>Action</th><th>Source</th><th>Matched</th><th>Before</th><th>After</th></tr></thead>
        <tbody>${filtered.map((e, i) => html`
          <tr key=${i}>
            <td>${ago(e.timestamp)}</td><td style=${{ fontWeight: 600 }}>${e.rule}</td><td><span className=${`badge ${e.type}`}>${e.type}</span></td><td>${e.action}</td><td>${e.source || "--"}</td>
            <td style=${{ color: "#ef4444", fontFamily: "monospace", fontSize: "11px" }}>${e.matched_text || "--"}</td>
            <td>${e.full_message ? html`<details><summary>view</summary><pre>${e.full_message}</pre></details>` : "--"}</td>
            <td>${e.redacted_message ? html`<details><summary>view</summary><pre>${e.redacted_message}</pre></details>` : "--"}</td>
          </tr>
        `)}</tbody>
      </table></div>
    `}
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// APP
// ════════════════════════════════════════════════════════════════════════════════

function App() {
  const [tab, setTab] = useState("dashboard");
  const [error, setError] = useState("");
  const [dash, setDash] = useState({});
  const [rules, setRules] = useState([]);
  const [audit, setAudit] = useState([]);

  useEffect(() => { load(tab); }, [tab]);
  useEffect(() => {
    const ms = tab === "dashboard" ? 3000 : tab === "audit" ? 5000 : 0;
    if (!ms) return;
    const t = setInterval(() => load(tab, true), ms);
    return () => clearInterval(t);
  }, [tab]);

  async function load(t = tab, silent = false) {
    if (!silent) setError("");
    try {
      if (t === "dashboard") {
        const [s, q, h] = await Promise.allSettled([api("/v1/stats"), api("/v1/quota"), api("/health")]);
        setDash((prev) => ({ stats: s.status === "fulfilled" ? s.value : prev.stats, quota: q.status === "fulfilled" ? q.value : prev.quota, health: h.status === "fulfilled" ? h.value : prev.health }));
      } else if (t === "rules") { setRules((await api("/v1/rules")).rules || []); }
      else if (t === "audit") { setAudit((await api("/v1/audit?limit=200")).entries || []); }
    } catch (e) { if (!silent) setError(e.message); }
  }

  const tabs = ["dashboard", "config", "rules", "audit"];

  return html`
    <div className="app">
      <div className="header"><div className="logo">Leeloo Admin</div><a className="nav-link" href="/ui">Chat UI</a><a className="nav-link" href="/health">Health</a></div>
      <div className="tabs">${tabs.map((t) => html`<button key=${t} className=${`tab ${tab === t ? "active" : ""}`} onClick=${() => setTab(t)}>${t}</button>`)}</div>
      <div className="panel"><div className="panel-inner">
        ${error ? html`<div className="card" style=${{ color: "#ef4444", borderColor: "#7f1d1d" }}>Error: ${error}</div>` : null}
        ${tab === "dashboard" ? html`<${DashboardPanel} data=${dash} />` : null}
        ${tab === "config" ? html`<${ConfigPanel} onRefresh=${() => load("dashboard", true)} />` : null}
        ${tab === "rules" ? html`<${RulesPanel} rules=${rules} onRefresh=${() => load("rules")} />` : null}
        ${tab === "audit" ? html`<${AuditPanel} entries=${audit} onRefresh=${() => load("audit")} />` : null}
      </div></div>
    </div>
  `;
}

createRoot(document.getElementById("app")).render(html`<${App} />`);
