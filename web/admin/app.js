import React, { useEffect, useMemo, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const BASE = location.origin;

async function fetchJson(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

function ago(ts) {
  if (!ts) return "--";
  const d = Date.now() - new Date(ts).getTime();
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  return `${Math.round(d / 3_600_000)}h ago`;
}

function Tabs({ active, setActive }) {
  const tabs = ["dashboard", "rules", "audit", "config"];
  return html`
    <div className="tabs">
      ${tabs.map((t) => html`
        <button
          key=${t}
          className=${`tab ${active === t ? "active" : ""}`}
          onClick=${() => setActive(t)}
        >${t}</button>
      `)}
    </div>
  `;
}

function DashboardPanel({ data }) {
  const stats = data?.stats || {};
  const session = stats.session || {};
  const providers = stats.providers || [];
  const recent = stats.recent || [];
  const quotaProviders = data?.quota?.providers || [];
  const exhausted = new Set(data?.health?.exhausted || []);

  return html`
    <div>
      <h2>Session overview</h2>
      <div className="stat-grid">
        <div className="stat"><div className="stat-num">${session.total_requests || 0}</div><div className="stat-label">Requests</div></div>
        <div className="stat"><div className="stat-num">${session.total_tokens_in || 0}</div><div className="stat-label">Tokens in</div></div>
        <div className="stat"><div className="stat-num">${session.total_tokens_out || 0}</div><div className="stat-label">Tokens out</div></div>
        <div className="stat"><div className="stat-num">${session.total_errors || 0}</div><div className="stat-label">Errors</div></div>
      </div>

      <h2>Provider health</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Provider</th><th>Quota</th><th>Status</th><th>Requests</th><th>Tokens</th><th>Last used</th></tr>
          </thead>
          <tbody>
            ${quotaProviders.map((p) => {
              const ps = providers.find((x) => x.provider === p.provider) || {};
              return html`
                <tr key=${p.provider}>
                  <td>${p.label || p.provider}</td>
                  <td>${p.score == null ? "?" : `${p.score}%`}</td>
                  <td>${exhausted.has(p.provider) ? "exhausted" : (p.status || "ok")}</td>
                  <td>${ps.requests || 0}</td>
                  <td>${ps.tokens_in || 0} / ${ps.tokens_out || 0}</td>
                  <td>${ago(ps.last_used)}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>

      <h2 style=${{ marginTop: "14px" }}>Recent requests</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Time</th><th>Provider</th><th>Model</th><th>Tokens</th><th>Duration</th><th>Error</th></tr>
          </thead>
          <tbody>
            ${recent.slice(0, 30).map((r, idx) => html`
              <tr key=${idx}>
                <td>${ago(r.timestamp)}</td>
                <td>${r.provider}</td>
                <td>${r.model}</td>
                <td>${r.tokens_in} / ${r.tokens_out}</td>
                <td>${r.duration_ms}ms</td>
                <td>${r.error || "--"}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function RuleForm({ onCreate, onCancel }) {
  const [name, setName] = useState(`rule-${Date.now()}`);
  const [type, setType] = useState("block");
  const [scope, setScope] = useState("request");
  const [patterns, setPatterns] = useState("");
  const [replacement, setReplacement] = useState("[REDACTED]");
  const [message, setMessage] = useState("");
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [maxRequests, setMaxRequests] = useState("60");
  const [windowSeconds, setWindowSeconds] = useState("60");

  async function submit() {
    const payload = {
      name,
      type,
      scope,
      enabled: true,
      patterns: patterns.split("\n").map((x) => x.trim()).filter(Boolean),
      replacement: replacement || undefined,
      message: message || undefined,
    };
    if (type === "model") {
      payload.allow = allow.split(",").map((x) => x.trim()).filter(Boolean);
      payload.deny = deny.split(",").map((x) => x.trim()).filter(Boolean);
    }
    if (type === "limit") {
      payload.maxRequests = parseInt(maxRequests || "60", 10);
      payload.windowSeconds = parseInt(windowSeconds || "60", 10);
    }
    await onCreate(payload);
  }

  return html`
    <div className="card">
      <div className="form-grid">
        <div>
          <label>Name</label>
          <input value=${name} onInput=${(e) => setName(e.target.value)} />
        </div>
        <div>
          <label>Type</label>
          <select value=${type} onChange=${(e) => setType(e.target.value)}>
            <option value="block">block</option>
            <option value="redact">redact</option>
            <option value="warn">warn</option>
            <option value="model">model</option>
            <option value="limit">limit</option>
          </select>
        </div>

        <div>
          <label>Scope</label>
          <select value=${scope} onChange=${(e) => setScope(e.target.value)}>
            <option value="request">request</option>
            <option value="response">response</option>
            <option value="both">both</option>
          </select>
        </div>

        ${(type === "block" || type === "redact" || type === "warn") && html`
          <div className="full">
            <label>Patterns (regex, one per line)</label>
            <textarea rows="4" value=${patterns} onInput=${(e) => setPatterns(e.target.value)} placeholder="AKIA[0-9A-Z]{16}"></textarea>
          </div>
        `}

        ${type === "redact" && html`
          <div>
            <label>Replacement</label>
            <input value=${replacement} onInput=${(e) => setReplacement(e.target.value)} />
          </div>
        `}

        ${(type === "block" || type === "limit" || type === "model") && html`
          <div>
            <label>Message (optional)</label>
            <input value=${message} onInput=${(e) => setMessage(e.target.value)} placeholder="Blocked by policy" />
          </div>
        `}

        ${type === "model" && [
          html`<div key="allow">
            <label>Allow list (comma-separated globs)</label>
            <input value=${allow} onInput=${(e) => setAllow(e.target.value)} placeholder="claude-*, gpt-5*" />
          </div>`,
          html`<div key="deny">
            <label>Deny list</label>
            <input value=${deny} onInput=${(e) => setDeny(e.target.value)} placeholder="gpt-4o*" />
          </div>`,
        ]}

        ${type === "limit" && [
          html`<div key="maxRequests">
            <label>Max requests</label>
            <input value=${maxRequests} onInput=${(e) => setMaxRequests(e.target.value)} type="number" />
          </div>`,
          html`<div key="windowSeconds">
            <label>Window seconds</label>
            <input value=${windowSeconds} onInput=${(e) => setWindowSeconds(e.target.value)} type="number" />
          </div>`,
        ]}
      </div>

      <div className="actions" style=${{ marginTop: "10px" }}>
        <button className="btn primary" onClick=${submit}>Create</button>
        <button className="btn" onClick=${onCancel}>Cancel</button>
      </div>
    </div>
  `;
}

function RulesPanel({ rules, onRefresh }) {
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggleRule(rule, enabled) {
    setBusy(true);
    try {
      await fetchJson(`/v1/rules/${encodeURIComponent(rule.name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(rule) {
    if (!confirm(`Delete rule ${rule.name}?`)) return;
    setBusy(true);
    try {
      await fetchJson(`/v1/rules/${encodeURIComponent(rule.name)}`, { method: "DELETE" });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function createRule(payload) {
    setBusy(true);
    try {
      await fetchJson(`/v1/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setShowForm(false);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div>
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <h2 style=${{ margin: 0 }}>Rules</h2>
        <div className="actions">
          <button className="btn" onClick=${onRefresh}>Refresh</button>
          <button className="btn primary" onClick=${() => setShowForm((v) => !v)}>${showForm ? "Close" : "+ Add rule"}</button>
        </div>
      </div>

      ${showForm ? html`<${RuleForm} onCreate=${createRule} onCancel=${() => setShowForm(false)} />` : null}

      ${rules.length === 0 ? html`<div className="empty">No rules configured.</div>` : null}

      ${rules.map((r) => html`
        <div className="card" key=${r.name + String(r.enabled)}>
          <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <span className="name">${r.name}</span>
              <span className=${`badge ${r.type}`}>${r.type}</span>
              <span className=${`badge ${r.enabled ? "on" : "off"}`}>${r.enabled ? "enabled" : "disabled"}</span>
            </div>
            <div className="actions">
              <button className="btn" disabled=${busy} onClick=${() => toggleRule(r, !r.enabled)}>${r.enabled ? "Disable" : "Enable"}</button>
              <button className="btn danger" disabled=${busy} onClick=${() => deleteRule(r)}>Delete</button>
            </div>
          </div>
          <div className="meta">
            scope: ${r.scope || "request"}
            ${r.patterns?.length ? html` | patterns: ${r.patterns.join(", ")}` : null}
            ${r.allow?.length ? html` | allow: ${r.allow.join(", ")}` : null}
            ${r.deny?.length ? html` | deny: ${r.deny.join(", ")}` : null}
            ${r.maxRequests ? html` | ${r.maxRequests} req/${r.windowSeconds}s` : null}
            ${r.replacement ? html` | replacement: ${r.replacement}` : null}
          </div>
        </div>
      `)}
    </div>
  `;
}

function AuditPanel({ entries, onRefresh }) {
  return html`
    <div>
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <h2 style=${{ margin: 0 }}>Audit log</h2>
        <button className="btn" onClick=${onRefresh}>Refresh</button>
      </div>

      ${entries.length === 0
        ? html`<div className="empty">No audit events yet.</div>`
        : html`
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Rule</th><th>Type</th><th>Action</th><th>Source</th><th>Detail</th><th>Matched</th><th>Before</th><th>After</th>
                </tr>
              </thead>
              <tbody>
                ${entries.map((e, idx) => html`
                  <tr key=${idx}>
                    <td>${ago(e.timestamp)}</td>
                    <td>${e.rule}</td>
                    <td>${e.type}</td>
                    <td>${e.action}</td>
                    <td>${e.source || "--"}</td>
                    <td>${e.detail}</td>
                    <td>${e.matched_text || "--"}</td>
                    <td>
                      ${e.full_message
                        ? html`<details><summary>view (${e.full_message.length})</summary><pre>${e.full_message}</pre></details>`
                        : "--"}
                    </td>
                    <td>
                      ${e.redacted_message
                        ? html`<details><summary>view (${e.redacted_message.length})</summary><pre>${e.redacted_message}</pre></details>`
                        : "--"}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
        `}
    </div>
  `;
}

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
        <div className="card" key=${p.name}>
          <span className="name">${p.name}</span>
          <span className="badge">${p.strategy}</span>
          <div className="meta">Members: ${(p.members || []).join(", ")}</div>
        </div>
      `)}

      <h2 style=${{ marginTop: "14px" }}>Presets</h2>
      ${presets.length === 0 ? html`<div className="empty">No presets</div>` : null}
      ${presets.map((p) => html`
        <div className="card" key=${p.name}>
          <span className="name">${p.name}</span>
          <div className="meta">${(p.entries || []).join(" -> ")}</div>
        </div>
      `)}

      <h2 style=${{ marginTop: "14px" }}>Providers</h2>
      ${providers.map((p) => html`
        <div className="card" key=${p}>
          <span className="name">${p}</span>
          <span className=${`badge ${exhausted.has(p) ? "off" : "on"}`}>${exhausted.has(p) ? "exhausted" : "ok"}</span>
        </div>
      `)}
    </div>
  `;
}

function App() {
  const [active, setActive] = useState("dashboard");
  const [error, setError] = useState("");

  const [dashboard, setDashboard] = useState({ stats: null, quota: null, health: null });
  const [rules, setRules] = useState([]);
  const [auditEntries, setAuditEntries] = useState([]);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    refreshTab(active);
  }, [active]);

  async function refreshTab(tab = active) {
    setError("");
    try {
      if (tab === "dashboard") {
        const [stats, quota, healthData] = await Promise.all([
          fetchJson("/v1/stats"),
          fetchJson("/v1/quota"),
          fetchJson("/health"),
        ]);
        setDashboard({ stats, quota, health: healthData });
      } else if (tab === "rules") {
        const data = await fetchJson("/v1/rules");
        setRules(data.rules || []);
      } else if (tab === "audit") {
        const data = await fetchJson("/v1/audit?limit=200");
        setAuditEntries(data.entries || []);
      } else if (tab === "config") {
        const h = await fetchJson("/health");
        setHealth(h);
      }
    } catch (e) {
      setError(e.message);
    }
  }

  let panel = null;
  if (active === "dashboard") panel = html`<${DashboardPanel} data=${dashboard} />`;
  if (active === "rules") panel = html`<${RulesPanel} rules=${rules} onRefresh=${() => refreshTab("rules")} />`;
  if (active === "audit") panel = html`<${AuditPanel} entries=${auditEntries} onRefresh=${() => refreshTab("audit")} />`;
  if (active === "config") panel = html`<${ConfigPanel} health=${health} />`;

  return html`
    <div className="app">
      <div className="header">
        <div className="title">Leeloo Admin</div>
        <a className="link" href="/ui">Chat UI</a>
        <a className="link" href="/health">Health API</a>
      </div>
      <${Tabs} active=${active} setActive=${setActive} />
      <div className="panel">
        ${error ? html`<div className="card" style=${{ color: "#ff7e7e" }}>Error: ${error}</div>` : null}
        ${panel}
      </div>
    </div>
  `;
}

createRoot(document.getElementById("app")).render(html`<${App} />`);
