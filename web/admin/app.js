import React, { useEffect, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const BASE = location.origin;

async function api(path, init) {
  const r = await fetch(`${BASE}${path}`, init);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  return r.json();
}

function ago(ts) {
  if (!ts) return "--";
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60e3) return `${Math.round(ms / 1e3)}s ago`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)}m ago`;
  return `${Math.round(ms / 36e5)}h ago`;
}

function qColor(s) { return s == null ? "#3f3f46" : s > 50 ? "#22c55e" : s > 20 ? "#eab308" : "#ef4444"; }

function QuotaBar({ score }) {
  return html`<span className="q-bar"><span className="q-fill" style=${{ width: `${score ?? 0}%`, background: qColor(score) }} /></span>`;
}

// ── Dashboard ──

function DashboardPanel({ data }) {
  const session = data?.stats?.session || {};
  const providers = data?.stats?.providers || [];
  const recent = data?.stats?.recent || [];
  const quotaProviders = data?.quota?.providers || [];
  const exhausted = new Set(data?.health?.exhausted || []);

  return html`
    <div>
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
        <tbody>
          ${quotaProviders.map((p) => {
            const ps = providers.find((x) => x.provider === p.provider) || {};
            const exh = exhausted.has(p.provider);
            return html`
              <tr key=${p.provider}>
                <td style=${{ color: "#fafafa", fontWeight: 500 }}>${p.label || p.provider}</td>
                <td><${QuotaBar} score=${p.score} /> <span style=${{ color: qColor(p.score) }}>${p.score == null ? "?" : `${p.score}%`}</span></td>
                <td>${exh ? html`<span className="badge off">exhausted</span>` : html`<span className="badge on">${p.status || "ok"}</span>`}</td>
                <td>${ps.requests || 0}</td>
                <td>${ps.tokens_in || 0} / ${ps.tokens_out || 0}</td>
                <td>${ago(ps.last_used)}</td>
              </tr>
            `;
          })}
        </tbody>
      </table></div>

      <h2 className="mt">Recent chats</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Provider</th><th>Model</th><th>Tokens</th><th>Duration</th><th>Error</th><th>Request</th><th>Response</th></tr></thead>
        <tbody>
          ${recent.length === 0 ? html`<tr><td colSpan="8" className="empty">No requests yet.</td></tr>` : null}
          ${recent.slice(0, 50).map((r, i) => html`
            <tr key=${i}>
              <td>${ago(r.timestamp)}</td>
              <td>${r.provider}</td>
              <td style=${{ fontFamily: "monospace", fontSize: "11px" }}>${r.model}</td>
              <td>${r.tokens_in} / ${r.tokens_out}</td>
              <td>${r.duration_ms}ms</td>
              <td>${r.error ? html`<span style=${{ color: "#ef4444" }}>${r.error}</span>` : "--"}</td>
              <td>${r.request_text ? html`<details><summary>${r.request_text.slice(0, 40)}...</summary><pre>${r.request_text}</pre></details>` : "--"}</td>
              <td>${r.response_text ? html`<details><summary>${r.response_text.slice(0, 40)}...</summary><pre>${r.response_text}</pre></details>` : "--"}</td>
            </tr>
          `)}
        </tbody>
      </table></div>
    </div>
  `;
}

// ── Rules ──

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
        ${type === "model" && [
          html`<div key="a"><label>Allow (globs)</label><input value=${allow} onInput=${(e) => setAllow(e.target.value)} placeholder="claude-*, gpt-5*" /></div>`,
          html`<div key="d"><label>Deny (globs)</label><input value=${deny} onInput=${(e) => setDeny(e.target.value)} placeholder="gpt-4o*" /></div>`,
        ]}
        ${type === "limit" && [
          html`<div key="mr"><label>Max requests</label><input value=${maxReq} onInput=${(e) => setMaxReq(e.target.value)} type="number" /></div>`,
          html`<div key="ws"><label>Window (seconds)</label><input value=${winSec} onInput=${(e) => setWinSec(e.target.value)} type="number" /></div>`,
        ]}
      </div>
      <div className="actions" style=${{ marginTop: "12px" }}><button className="btn primary" onClick=${submit}>Create</button><button className="btn" onClick=${onCancel}>Cancel</button></div>
    </div>
  `;
}

function RulesPanel({ rules, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle(r, enabled) { setBusy(true); try { await api(`/v1/rules/${encodeURIComponent(r.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }); await onRefresh(); } finally { setBusy(false); } }
  async function del(r) { if (!confirm(`Delete "${r.name}"?`)) return; setBusy(true); try { await api(`/v1/rules/${encodeURIComponent(r.name)}`, { method: "DELETE" }); await onRefresh(); } finally { setBusy(false); } }
  async function create(payload) { setBusy(true); try { await api("/v1/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); setShowForm(false); await onRefresh(); } finally { setBusy(false); } }

  return html`
    <div>
      <div className="card-row" style=${{ marginBottom: "12px" }}>
        <h2 style=${{ margin: 0 }}>Policy rules</h2>
        <div className="actions"><button className="btn" onClick=${onRefresh}>Refresh</button><button className="btn primary" onClick=${() => setShowForm((v) => !v)}>${showForm ? "Close" : "+ Add rule"}</button></div>
      </div>
      ${showForm ? html`<${RuleForm} onCreate=${create} onCancel=${() => setShowForm(false)} />` : null}
      ${rules.length === 0 ? html`<div className="empty">No rules configured. Click "+ Add rule" to create DLP policies.</div>` : null}
      ${rules.map((r) => html`
        <div className="card" key=${r.name}>
          <div className="card-row">
            <div>
              <span className="name">${r.name}</span>
              <span className=${`badge ${r.type}`}>${r.type}</span>
              <span className=${`badge ${r.enabled ? "on" : "off"}`}>${r.enabled ? "on" : "off"}</span>
              <span className="badge neutral">${r.scope || "request"}</span>
            </div>
            <div className="actions">
              <button className="btn" disabled=${busy} onClick=${() => toggle(r, !r.enabled)}>${r.enabled ? "Disable" : "Enable"}</button>
              <button className="btn danger" disabled=${busy} onClick=${() => del(r)}>Delete</button>
            </div>
          </div>
          <div className="meta">
            ${r.patterns?.length ? `patterns: ${r.patterns.join(", ")}` : ""}
            ${r.allow?.length ? ` | allow: ${r.allow.join(", ")}` : ""}
            ${r.deny?.length ? ` | deny: ${r.deny.join(", ")}` : ""}
            ${r.maxRequests ? ` | ${r.maxRequests} req/${r.windowSeconds}s` : ""}
            ${r.replacement ? ` | replacement: ${r.replacement}` : ""}
            ${r.message ? ` | msg: ${r.message}` : ""}
          </div>
        </div>
      `)}
    </div>
  `;
}

// ── Audit ──

function AuditPanel({ entries, onRefresh }) {
  const [filter, setFilter] = useState("");
  const filtered = filter ? entries.filter((e) => e.rule?.includes(filter) || e.action?.includes(filter) || e.detail?.includes(filter)) : entries;

  return html`
    <div>
      <div className="card-row" style=${{ marginBottom: "12px" }}>
        <h2 style=${{ margin: 0 }}>Audit log</h2>
        <div className="actions">
          <input value=${filter} onInput=${(e) => setFilter(e.target.value)} placeholder="Filter..." style=${{ width: "160px", padding: "5px 8px", fontSize: "12px" }} />
          <button className="btn" onClick=${onRefresh}>Refresh</button>
        </div>
      </div>
      ${filtered.length === 0 ? html`<div className="empty">No audit events${filter ? " matching filter" : ""}.</div>` : html`
        <div className="table-wrap"><table>
          <thead><tr><th>Time</th><th>Rule</th><th>Type</th><th>Action</th><th>Source</th><th>Matched</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            ${filtered.map((e, i) => html`
              <tr key=${i}>
                <td>${ago(e.timestamp)}</td>
                <td style=${{ fontWeight: 600 }}>${e.rule}</td>
                <td><span className=${`badge ${e.type}`}>${e.type}</span></td>
                <td>${e.action}</td>
                <td>${e.source || "--"}</td>
                <td style=${{ color: "#ef4444", fontFamily: "monospace", fontSize: "11px" }}>${e.matched_text || "--"}</td>
                <td>${e.full_message ? html`<details><summary>view</summary><pre>${e.full_message}</pre></details>` : "--"}</td>
                <td>${e.redacted_message ? html`<details><summary>view</summary><pre>${e.redacted_message}</pre></details>` : "--"}</td>
              </tr>
            `)}
          </tbody>
        </table></div>
      `}
    </div>
  `;
}

// ── Config ──

function ConfigPanel({ health }) {
  const pools = health?.pools || [];
  const presets = health?.presets || [];
  const providers = health?.providers || [];
  const exhausted = new Set(health?.exhausted || []);

  return html`
    <div>
      <h2>Pools</h2>
      ${pools.length === 0 ? html`<div className="empty">No pools</div>` : null}
      ${pools.map((p) => html`
        <div className="card" key=${p.name}><span className="name">${p.name}</span><span className="badge neutral">${p.strategy}</span><div className="meta">Members: ${p.members?.join(", ")}</div></div>
      `)}
      <h2 className="mt">Presets</h2>
      ${presets.length === 0 ? html`<div className="empty">No presets</div>` : null}
      ${presets.map((p) => html`<div className="card" key=${p.name}><span className="name">${p.name}</span><div className="meta">${p.entries?.join(" -> ")}</div></div>`)}
      <h2 className="mt">Providers</h2>
      ${providers.map((p) => html`<div className="card" key=${p}><span className="name">${p}</span><span className=${`badge ${exhausted.has(p) ? "off" : "on"}`}>${exhausted.has(p) ? "exhausted" : "ok"}</span></div>`)}
    </div>
  `;
}

// ── App ──

function App() {
  const [tab, setTab] = useState("dashboard");
  const [error, setError] = useState("");
  const [dash, setDash] = useState({});
  const [rules, setRules] = useState([]);
  const [audit, setAudit] = useState([]);
  const [health, setHealth] = useState(null);

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
      else if (t === "config") { setHealth(await api("/health")); }
    } catch (e) { if (!silent) setError(e.message); }
  }

  const tabs = ["dashboard", "rules", "audit", "config"];

  return html`
    <div className="app">
      <div className="header">
        <div className="logo">Leeloo Admin</div>
        <a className="nav-link" href="/ui">Chat UI</a>
        <a className="nav-link" href="/health">Health</a>
      </div>
      <div className="tabs">
        ${tabs.map((t) => html`<button key=${t} className=${`tab ${tab === t ? "active" : ""}`} onClick=${() => setTab(t)}>${t}</button>`)}
      </div>
      <div className="panel"><div className="panel-inner">
        ${error ? html`<div className="card" style=${{ color: "#ef4444", borderColor: "#7f1d1d" }}>Error: ${error}</div>` : null}
        ${tab === "dashboard" ? html`<${DashboardPanel} data=${dash} />` : null}
        ${tab === "rules" ? html`<${RulesPanel} rules=${rules} onRefresh=${() => load("rules")} />` : null}
        ${tab === "audit" ? html`<${AuditPanel} entries=${audit} onRefresh=${() => load("audit")} />` : null}
        ${tab === "config" ? html`<${ConfigPanel} health=${health} />` : null}
      </div></div>
    </div>
  `;
}

createRoot(document.getElementById("app")).render(html`<${App} />`);
