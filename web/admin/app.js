import React, { useEffect, useState, useCallback, useRef } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";
import DiffMatchPatch from "https://esm.sh/diff-match-patch@1.0.5";

const html = htm.bind(React.createElement);
const BASE = location.origin;
const STRATEGIES = ["round-robin", "quota-first", "scheduled", "custom"];
const BASE_PROVIDERS = ["anthropic", "openai-codex", "github-copilot", "google-gemini-cli", "google-antigravity"];
const TOKEN_KEY = "leeloo.token";

function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }

async function api(path, init) {
  const headers = { ...(init?.headers || {}), Authorization: `Bearer ${getToken()}` };
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); location.reload(); throw new Error("Session expired"); }
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  return r.json();
}
function jpost(d) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }; }
function jput(d) { return { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }; }

function ago(ts) {
  if (!ts) return "--";
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 60e3) return `${Math.round(ms / 1e3)}s ago`;
  if (ms < 36e5) return `${Math.round(ms / 6e4)}m ago`;
  return `${Math.round(ms / 36e5)}h ago`;
}
function qColor(s) { return s == null ? "#3f3f46" : s > 50 ? "#22c55e" : s > 20 ? "#eab308" : "#ef4444"; }
function QuotaBar({ score }) { return html`<span className="q-bar"><span className="q-fill" style=${{ width: `${score ?? 0}%`, background: qColor(score) }} /></span>`; }

/** Shared hook: load known provider/pool/chain names for dropdowns */
function useNames() {
  const [names, setNames] = useState({ providers: [], pools: [], chains: [] });
  const load = useCallback(async () => {
    try { setNames(await api("/v1/auth/names")); } catch {}
  }, []);
  useEffect(() => { load(); }, []);
  return { names, reloadNames: load };
}

/** Dropdown for selecting a provider/subscription */
function ProviderSelect({ value, onChange, names, allowPools, allowChains, placeholder }) {
  const provs = names?.providers || [];
  const pools = names?.pools || [];
  const chains = names?.chains || [];
  return html`
    <select value=${value || ""} onChange=${(e) => onChange(e.target.value)}>
      <option value="">${placeholder || "-- select --"}</option>
      <optgroup label="Providers">
        ${provs.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}${p.authenticated ? "" : " (no auth)"}</option>`)}
      </optgroup>
      ${allowPools && pools.length ? html`
        <optgroup label="Pools">
          ${pools.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}
        </optgroup>
      ` : null}
      ${allowChains && chains.length ? html`
        <optgroup label="Chains">
          ${chains.map((c) => html`<option key=${c.id} value=${c.id}>${c.label}</option>`)}
        </optgroup>
      ` : null}
    </select>
  `;
}

/** Drag-and-drop sortable list. items=array, onReorder=callback, renderItem(item,index)=JSX */
function SortableList({ items, onReorder, renderItem }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  function onDragStart(e, i) { setDragIdx(i); e.dataTransfer.effectAllowed = "move"; }
  function onDragOver(e, i) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverIdx(i); }
  function onDragLeave() { setOverIdx(null); }
  function onDrop(e, i) {
    e.preventDefault();
    if (dragIdx == null || dragIdx === i) { setDragIdx(null); setOverIdx(null); return; }
    const arr = [...items];
    const [moved] = arr.splice(dragIdx, 1);
    arr.splice(i, 0, moved);
    onReorder(arr);
    setDragIdx(null);
    setOverIdx(null);
  }
  function onDragEnd() { setDragIdx(null); setOverIdx(null); }

  return html`<div>
    ${items.map((item, i) => html`
      <div key=${i}
        draggable="true"
        onDragStart=${(e) => onDragStart(e, i)}
        onDragOver=${(e) => onDragOver(e, i)}
        onDragLeave=${onDragLeave}
        onDrop=${(e) => onDrop(e, i)}
        onDragEnd=${onDragEnd}
        style=${{
          display: "flex", gap: "6px", marginBottom: "4px", alignItems: "center",
          padding: "4px 6px", borderRadius: "6px", cursor: "grab",
          background: overIdx === i ? "#1e1e22" : dragIdx === i ? "#111113" : "transparent",
          border: overIdx === i ? "1px dashed #f59e0b" : "1px solid transparent",
          opacity: dragIdx === i ? 0.5 : 1,
          transition: "background .1s, border .1s",
        }}
      >
        <span style=${{ color: "#3f3f46", fontSize: "14px", cursor: "grab", userSelect: "none" }}>${"\u2630"}</span>
        ${renderItem(item, i)}
      </div>
    `)}
  </div>`;
}

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
        const statusBadge = exhausted.has(p.provider)
          ? html`<span className="badge off">exhausted</span>`
          : p.status === "expired"
            ? html`<span className="badge warn">expired - re-login</span>`
            : p.status === "no-auth"
              ? html`<span className="badge off">no auth</span>`
              : p.status === "error"
                ? html`<span className="badge off" title=${p.error || ""}>${p.error?.slice(0, 30) || "error"}</span>`
                : html`<span className="badge on">${p.status || "ok"}</span>`;
        return html`<tr key=${p.provider}><td style=${{ color: "#fafafa", fontWeight: 500 }}>${p.label || p.provider}</td><td><${QuotaBar} score=${p.score} /> <span style=${{ color: qColor(p.score) }}>${p.score == null ? "?" : `${p.score}%`}</span></td><td>${statusBadge}</td><td>${ps.requests || 0}</td><td>${ps.tokens_in || 0} / ${ps.tokens_out || 0}</td><td>${ago(ps.last_used)}</td></tr>`;
      })}</tbody>
    </table></div>
    ${(data?.stats?.users || []).length > 0 ? html`
      <h2 className="mt">Per-user usage</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>User</th><th>Requests</th><th>Tokens in</th><th>Tokens out</th><th>Errors</th><th>Last used</th></tr></thead>
        <tbody>${(data.stats.users || []).map((u) => html`
          <tr key=${u.username}><td style=${{ fontWeight: 500, color: "#fafafa" }}>${u.username}</td><td>${u.requests}</td><td>${u.tokens_in}</td><td>${u.tokens_out}</td><td>${u.errors}</td><td>${ago(u.last_used)}</td></tr>
        `)}</tbody>
      </table></div>
    ` : null}
    <h2 className="mt">Recent chats</h2>
    <div className="table-wrap"><table>
      <thead><tr><th>Time</th><th>User</th><th>Provider</th><th>Model</th><th>Tokens</th><th>Duration</th><th>Error</th><th>Request</th><th>Response</th></tr></thead>
      <tbody>${recent.length === 0 ? html`<tr><td colSpan="9" className="empty">No requests yet.</td></tr>` : recent.slice(0, 50).map((r, i) => html`<tr key=${i}><td>${ago(r.timestamp)}</td><td>${r.user || "--"}</td><td>${r.provider}</td><td style=${{ fontFamily: "monospace", fontSize: "11px" }}>${r.model}</td><td>${r.tokens_in} / ${r.tokens_out}</td><td>${r.duration_ms}ms</td><td>${r.error ? html`<span style=${{ color: "#ef4444" }}>${r.error}</span>` : "--"}</td><td>${r.request_text ? html`<details><summary>${r.request_text.slice(0, 40)}...</summary><pre>${r.request_text}</pre></details>` : "--"}</td><td>${r.response_text ? html`<details><summary>${r.response_text.slice(0, 40)}...</summary><pre>${r.response_text}</pre></details>` : "--"}</td></tr>`)}</tbody>
    </table></div>
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// CONFIG EDITOR
// ════════════════════════════════════════════════════════════════════════════════

// ── Auth / OAuth ──

function AuthPanel({ onRefresh, reloadNames }) {
  const [providers, setProviders] = useState([]);
  const [busy, setBusy] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [newBase, setNewBase] = useState(BASE_PROVIDERS[0]);
  const [newName, setNewName] = useState("");

  async function loadProviders() {
    try { const d = await api("/v1/auth/providers"); setProviders(d.providers || []); } catch {}
  }
  useEffect(() => { loadProviders(); }, []);

  // startLogin: oauthProvider = the base provider to run OAuth against
  //             storeAs = the name to store credentials under (for new subscriptions)
  async function startLogin(oauthProvider, storeAs) {
    const trackId = storeAs || oauthProvider;
    setBusy((b) => ({ ...b, [trackId]: "connecting..." }));
    try {
      const qs = storeAs ? `?storeAs=${encodeURIComponent(storeAs)}` : "";
      const res = await api(`/v1/auth/login/${encodeURIComponent(oauthProvider)}${qs}`, { method: "POST" });
      if (res.authUrl) {
        window.open(res.authUrl, "_blank");
        setBusy((b) => ({ ...b, [trackId]: "waiting for browser..." }));
        pollLogin(oauthProvider, storeAs);
      }
    } catch (e) {
      setBusy((b) => ({ ...b, [trackId]: `error: ${e.message}` }));
      setTimeout(() => setBusy((b) => { const n = { ...b }; delete n[trackId]; return n; }), 3000);
    }
  }

  async function pollLogin(oauthProvider, storeAs) {
    const trackId = storeAs || oauthProvider;
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const qs = storeAs ? `?storeAs=${encodeURIComponent(storeAs)}` : "";
        const s = await api(`/v1/auth/login/${encodeURIComponent(oauthProvider)}${qs}`);
        if (s.status === "authenticated" || s.hasAuth) {
          setBusy((b) => { const n = { ...b }; delete n[trackId]; return n; });
          await loadProviders();
          if (reloadNames) reloadNames();
          if (onRefresh) onRefresh();
          return;
        }
      } catch {}
    }
    setBusy((b) => ({ ...b, [trackId]: "timed out" }));
  }

  async function logout(providerId) {
    if (!confirm(`Logout from ${providerId}?`)) return;
    try {
      await api(`/v1/auth/logout/${encodeURIComponent(providerId)}`, { method: "POST" });
      await loadProviders();
      if (reloadNames) reloadNames();
      if (onRefresh) onRefresh();
    } catch {}
  }

  async function addAccount() {
    const label = newName.trim();
    setBusy((b) => ({ ...b, __new__: "creating..." }));
    try {
      // 1. Create subscription entry (backend auto-assigns index)
      const res = await api("/v1/config/subscriptions", jpost({ provider: newBase, label }));
      const subId = res.subId; // e.g. "openai-codex-2"
      setShowAdd(false);
      setNewName("");
      if (onRefresh) onRefresh();
      if (reloadNames) reloadNames();
      await loadProviders();
      // 2. Start OAuth for base provider, store credentials under the subscription ID
      startLogin(newBase, subId);
    } catch (e) {
      setBusy((b) => ({ ...b, __new__: `error: ${e.message}` }));
    }
    setBusy((b) => { const n = { ...b }; delete n.__new__; return n; });
  }

  return html`<div>
    <div className="card-row" style=${{ marginBottom: "10px" }}>
      <h2 style=${{ margin: 0 }}>OAuth accounts</h2>
      <button className="btn primary" onClick=${() => setShowAdd((v) => !v)}>${showAdd ? "Cancel" : "+ Add account"}</button>
    </div>
    <div style=${{ marginBottom: "10px", fontSize: "11px", color: "#52525b" }}>Login to providers to enable routing. Add extra accounts for the same provider to enable pool rotation.</div>

    ${showAdd ? html`
      <div className="card" style=${{ marginBottom: "12px" }}>
        <div className="form-grid">
          <div><label>Base provider</label><select value=${newBase} onChange=${(e) => setNewBase(e.target.value)}>${BASE_PROVIDERS.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}</select></div>
          <div><label>Label (optional)</label><input value=${newName} onInput=${(e) => setNewName(e.target.value)} placeholder="e.g. work account, helmut@..." /></div>
        </div>
        <div className="actions" style=${{ marginTop: "10px" }}>
          <button className="btn primary" onClick=${addAccount} disabled=${!!busy.__new__}>${busy.__new__ || "Create & Login"}</button>
        </div>
      </div>
    ` : null}

    ${providers.map((p) => html`
      <div className="card" key=${p.id}>
        <div className="card-row">
          <div>
            <span className="name">${p.name}</span>
            <span className="badge neutral" style=${{ fontFamily: "monospace" }}>${p.id}</span>
            <span className=${`badge ${p.tokenStatus === "ok" ? "on" : p.tokenStatus === "expired" ? "warn" : "off"}`}>${
              p.tokenStatus === "ok" ? "logged in" :
              p.tokenStatus === "expired" ? "token expired" :
              "not logged in"
            }</span>
          </div>
          <div className="actions">
            ${busy[p.id]
              ? html`<span style=${{ fontSize: "12px", color: "#f59e0b" }}>${busy[p.id]}</span>`
              : html`
                <button className="btn primary" onClick=${() => startLogin(p.baseProvider || p.id, p.isBuiltin ? null : p.id)}>${p.authenticated ? "Re-login" : "Login"}</button>
                ${p.authenticated ? html`<button className="btn danger" onClick=${() => logout(p.id)}>Logout</button>` : null}
              `}
          </div>
        </div>
      </div>
    `)}
    ${providers.length === 0 ? html`<div className="empty">Loading providers...</div>` : null}
  </div>`;
}

// ── Schedule editor ──

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ROLES = [{ value: "", label: "default (always available)" }, { value: "preferred", label: "preferred (active in windows only)" }, { value: "overflow", label: "overflow (last resort)" }];

function ScheduleEditor({ members, schedule, onChange }) {
  // schedule = { memberName: { role, windows: [{ hours, days, dateRange }] } }
  const sched = schedule || {};

  function setMemberField(member, field, value) {
    const ms = { ...sched, [member]: { ...(sched[member] || {}), [field]: value } };
    if (field === "role" && !value) delete ms[member].role;
    onChange(ms);
  }

  function getWindows(member) { return sched[member]?.windows || []; }

  function setWindows(member, windows) {
    const ms = { ...sched, [member]: { ...(sched[member] || {}), windows } };
    onChange(ms);
  }

  function addWindow(member) {
    setWindows(member, [...getWindows(member), { hours: [9, 17], days: [...ALL_DAYS] }]);
  }

  function updateWindow(member, idx, field, value) {
    const wins = [...getWindows(member)];
    wins[idx] = { ...wins[idx], [field]: value };
    setWindows(member, wins);
  }

  function removeWindow(member, idx) {
    setWindows(member, getWindows(member).filter((_, i) => i !== idx));
  }

  function toggleDay(member, idx, day) {
    const wins = [...getWindows(member)];
    const w = { ...wins[idx] };
    const days = w.days || [...ALL_DAYS];
    w.days = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
    wins[idx] = w;
    setWindows(member, wins);
  }

  if (members.length === 0) return html`<div className="empty" style=${{ padding: "10px" }}>Add members first, then configure their schedules.</div>`;

  return html`
    <div>
      ${members.map((member) => {
        const ms = sched[member] || {};
        const windows = ms.windows || [];
        return html`
          <div key=${member} className="card" style=${{ marginBottom: "8px", padding: "10px 14px" }}>
            <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <span className="name" style=${{ fontSize: "13px" }}>${member}</span>
              <select value=${ms.role || ""} onChange=${(e) => setMemberField(member, "role", e.target.value || undefined)} style=${{ width: "240px", fontSize: "12px" }}>
                ${ROLES.map((r) => html`<option key=${r.value} value=${r.value}>${r.label}</option>`)}
              </select>
            </div>
            ${windows.map((w, wi) => html`
              <div key=${wi} style=${{ background: "#0d0d0f", border: "1px solid #27272a", borderRadius: "8px", padding: "8px 10px", marginBottom: "6px" }}>
                <div style=${{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
                  <label style=${{ margin: 0, width: "auto" }}>Hours:</label>
                  <input type="number" min="0" max="23" value=${w.hours?.[0] ?? 0} onInput=${(e) => updateWindow(member, wi, "hours", [parseInt(e.target.value) || 0, w.hours?.[1] ?? 24])} style=${{ width: "60px" }} />
                  <span style=${{ color: "#52525b" }}>to</span>
                  <input type="number" min="0" max="24" value=${w.hours?.[1] ?? 24} onInput=${(e) => updateWindow(member, wi, "hours", [w.hours?.[0] ?? 0, parseInt(e.target.value) || 24])} style=${{ width: "60px" }} />
                  <span style=${{ color: "#3f3f46", fontSize: "11px" }}>(24h, wraps midnight)</span>
                  <div className="spacer" />
                  <button className="btn danger" onClick=${() => removeWindow(member, wi)} style=${{ padding: "2px 8px", fontSize: "11px" }}>Remove</button>
                </div>
                <div style=${{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                  ${ALL_DAYS.map((day) => {
                    const active = (w.days || ALL_DAYS).includes(day);
                    return html`<button key=${day} className=${`btn ${active ? "primary" : ""}`} onClick=${() => toggleDay(member, wi, day)} style=${{ padding: "2px 8px", fontSize: "11px", minWidth: "36px" }}>${day}</button>`;
                  })}
                </div>
              </div>
            `)}
            <button className="btn" onClick=${() => addWindow(member)} style=${{ fontSize: "11px" }}>+ Add time window</button>
          </div>
        `;
      })}
    </div>
  `;
}

// ── Pools ──

function PoolEditor({ pools, names, onSave }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const providerNames = (names?.providers || []).map((p) => p.id);

  function startEdit(p) { setEditing(p.name); setDraft({ ...p, members: [...(p.members || [])] }); }
  function startNew() { setEditing("__new__"); setDraft({ name: "", enabled: true, baseProvider: BASE_PROVIDERS[0], members: [], strategy: "round-robin" }); }
  function cancel() { setEditing(null); }
  async function save() {
    if (editing === "__new__") { await api("/v1/config/pools", jpost(draft)); }
    else { await api(`/v1/config/pools/${encodeURIComponent(editing)}`, jput(draft)); }
    setEditing(null); onSave();
  }
  async function del(name) { if (confirm(`Delete pool "${name}"?`)) { await api(`/v1/config/pools/${encodeURIComponent(name)}`, { method: "DELETE" }); onSave(); } }

  function addMember(val) { if (val && !draft.members.includes(val)) setDraft({ ...draft, members: [...draft.members, val] }); }
  function removeMember(i) { setDraft({ ...draft, members: draft.members.filter((_, idx) => idx !== i) }); }

  function renderForm(isNew) {
    // Filter providers to those matching the base provider
    const eligible = providerNames.filter((n) => n === draft.baseProvider || n.startsWith(draft.baseProvider + "-"));
    return html`
      <div className="card">
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. codex-pool" /></div>
          <div><label>Base provider</label><select value=${draft.baseProvider} onChange=${(e) => setDraft({ ...draft, baseProvider: e.target.value })}>${BASE_PROVIDERS.map((p) => html`<option key=${p} value=${p}>${p}</option>`)}</select></div>
          <div><label>Strategy</label><select value=${draft.strategy} onChange=${(e) => setDraft({ ...draft, strategy: e.target.value })}>${STRATEGIES.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}</select></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
          <div className="full">
            <label>Members (drag to reorder priority)</label>
            ${draft.members.length > 0 ? html`
              <${SortableList} items=${draft.members} onReorder=${(arr) => setDraft({ ...draft, members: arr })} renderItem=${(m, i) => html`
                <span style=${{ flex: 1, fontSize: "13px", color: "#e4e4e7" }}>${m}</span>
                <button className="btn danger" onClick=${() => removeMember(i)} style=${{ padding: "2px 8px", fontSize: "11px" }}>x</button>
              `} />
            ` : html`<div style=${{ color: "#52525b", fontSize: "12px", padding: "6px 0" }}>No members yet</div>`}
            <div style=${{ display: "flex", gap: "6px", marginTop: "4px" }}>
              <select onChange=${(e) => { addMember(e.target.value); e.target.value = ""; }} style=${{ flex: 1 }}>
                <option value="">+ Add member...</option>
                ${eligible.filter((n) => !draft.members.includes(n)).map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
              </select>
            </div>
          </div>
          ${draft.strategy === "scheduled" ? html`<div className="full"><label>Member schedules</label><${ScheduleEditor} members=${draft.members} schedule=${draft.memberSchedule || {}} onChange=${(s) => setDraft({ ...draft, memberSchedule: s })} /></div>` : null}
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

function ChainEditor({ chains, names, onSave }) {
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

  function updateStep(i, field, value) { const steps = [...draft.steps]; steps[i] = { ...steps[i], [field]: value }; setDraft({ ...draft, steps }); }
  function addStep() { setDraft({ ...draft, steps: [...draft.steps, { provider: "", enabled: true }] }); }
  function removeStep(i) { setDraft({ ...draft, steps: draft.steps.filter((_, idx) => idx !== i) }); }

  function renderForm(isNew) {
    return html`
      <div className="card">
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. premium-fallback" /></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
        <div style=${{ marginTop: "10px" }}>
          <label>Steps (drag to reorder)</label>
          <${SortableList} items=${draft.steps} onReorder=${(arr) => setDraft({ ...draft, steps: arr })} renderItem=${(s, i) => html`
            <${ProviderSelect} value=${s.provider} onChange=${(v) => updateStep(i, "provider", v)} names=${names} allowPools=${true} placeholder="provider or pool" />
            <button className="btn danger" onClick=${() => removeStep(i)} style=${{ padding: "4px 8px" }}>x</button>
          `} />
          <button className="btn" onClick=${addStep} style=${{ marginTop: "4px" }}>+ Add step</button>
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
        <div className="meta">${(c.steps || []).map((s) => s.provider).join(" -> ") || "no steps"}</div>
      </div>
    `)}
    ${editing === "__new__" ? renderForm(true) : null}
  </div>`;
}

// ── Presets ──

function PresetEditor({ presets, names, onSave }) {
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

  function updateEntry(i, field, value) { const entries = [...draft.entries]; entries[i] = { ...entries[i], [field]: field === "enabled" ? value === "true" : value }; setDraft({ ...draft, entries }); }
  function addEntry() { setDraft({ ...draft, entries: [...draft.entries, { provider: "", enabled: true }] }); }
  function removeEntry(i) { setDraft({ ...draft, entries: draft.entries.filter((_, idx) => idx !== i) }); }

  function renderForm(isNew) {
    return html`
      <div className="card">
        <div className="form-grid">
          <div><label>Name</label><input value=${draft.name} onInput=${(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. coding-premium" /></div>
          <div><label>Enabled</label><select value=${String(draft.enabled)} onChange=${(e) => setDraft({ ...draft, enabled: e.target.value === "true" })}><option value="true">Yes</option><option value="false">No</option></select></div>
        </div>
        <div style=${{ marginTop: "10px" }}>
          <label>Entries (drag to reorder)</label>
          <${SortableList} items=${draft.entries} onReorder=${(arr) => setDraft({ ...draft, entries: arr })} renderItem=${(e, i) => html`
            <${ProviderSelect} value=${e.provider} onChange=${(v) => updateEntry(i, "provider", v)} names=${names} allowPools=${true} allowChains=${true} placeholder="provider, pool, or chain" />
            <select value=${String(e.enabled !== false)} onChange=${(ev) => updateEntry(i, "enabled", ev.target.value)} style=${{ width: "60px", fontSize: "12px" }}><option value="true">On</option><option value="false">Off</option></select>
            <button className="btn danger" onClick=${() => removeEntry(i)} style=${{ padding: "4px 8px" }}>x</button>
          `} />
          <button className="btn" onClick=${addEntry} style=${{ marginTop: "4px" }}>+ Add entry</button>
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
        <div className="meta">${(p.entries || []).filter((e) => e.enabled !== false).map((e) => e.provider).join(" -> ") || "no entries"}</div>
      </div>
    `)}
    ${editing === "__new__" ? renderForm(true) : null}
  </div>`;
}

// ── ConfigPanel (combines all) ──

function ConfigPanel({ onRefresh }) {
  const [config, setConfig] = useState(null);
  const [err, setErr] = useState("");
  const { names, reloadNames } = useNames();

  async function load() { setErr(""); try { setConfig(await api("/v1/config")); } catch (e) { setErr(e.message); } }
  useEffect(() => { load(); }, []);

  async function refresh() { await load(); reloadNames(); if (onRefresh) onRefresh(); }

  if (!config) return html`<div className="empty">${err || "Loading..."}</div>`;

  return html`<div>
    ${err ? html`<div className="card" style=${{ color: "#ef4444", borderColor: "#7f1d1d" }}>Error: ${err}</div>` : null}
    <${AuthPanel} onRefresh=${refresh} reloadNames=${reloadNames} />
    <div style=${{ marginTop: "24px" }} />
    <div style=${{ marginBottom: "6px", fontSize: "11px", color: "#52525b" }}>Editing: ~/.pi/agent/multi-pass.json</div>
    <${PoolEditor} pools=${config.pools || []} names=${names} onSave=${refresh} />
    <div style=${{ marginTop: "20px" }} />
    <${ChainEditor} chains=${config.chains || []} names=${names} onSave=${refresh} />
    <div style=${{ marginTop: "20px" }} />
    <${PresetEditor} presets=${config.presets || []} names=${names} onSave=${refresh} />
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
          ${r.patterns?.length ? `patterns: ${r.patterns.join(", ")}` : ""}${r.allow?.length ? ` | allow: ${r.allow.join(", ")}` : ""}${r.deny?.length ? ` | deny: ${r.deny.join(", ")}` : ""}${r.maxRequests ? ` | ${r.maxRequests} req/${r.windowSeconds}s` : ""}${r.replacement ? ` | replace: ${r.replacement}` : ""}${r.message ? ` | msg: ${r.message}` : ""}
        </div>
      </div>
    `)}
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════════════════

const dmp = new DiffMatchPatch();

function InlineDiff({ before, after }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !before || !after) return;
    const diffs = dmp.diff_main(before, after);
    dmp.diff_cleanupSemantic(diffs);
    let html = "";
    for (const [op, text] of diffs) {
      const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      if (op === -1) html += '<span class="diff-del">' + esc + "</span>";
      else if (op === 1) html += '<span class="diff-ins">' + esc + "</span>";
      else html += '<span class="diff-eq">' + esc + "</span>";
    }
    ref.current.innerHTML = html;
  }, [before, after]);
  return React.createElement("pre", { ref, className: "diff-view" });
}

function AuditPanel({ entries, onRefresh }) {
  const [filter, setFilter] = useState("");
  const filtered = filter ? entries.filter((e) => e.rule?.includes(filter) || e.action?.includes(filter) || e.detail?.includes(filter) || e.matched_text?.includes(filter)) : entries;

  function renderContent(e) {
    if (e.full_message && e.redacted_message && e.full_message !== e.redacted_message) {
      return html`<details><summary>diff</summary><${InlineDiff} before=${e.full_message} after=${e.redacted_message} /></details>`;
    }
    if (e.full_message) {
      return html`<details><summary>view</summary><pre>${e.full_message}</pre></details>`;
    }
    return "--";
  }

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
        <thead><tr><th>Time</th><th>Rule</th><th>Type</th><th>Action</th><th>Source</th><th>Matched</th><th>Content</th></tr></thead>
        <tbody>${filtered.map((e, i) => html`
          <tr key=${i}>
            <td>${ago(e.timestamp)}</td>
            <td style=${{ fontWeight: 600 }}>${e.rule}</td>
            <td><span className=${`badge ${e.type}`}>${e.type}</span></td>
            <td>${e.action}</td>
            <td>${e.source || "--"}</td>
            <td style=${{ color: "#ef4444", fontFamily: "monospace", fontSize: "11px" }}>${e.matched_text || "--"}</td>
            <td>${renderContent(e)}</td>
          </tr>
        `)}</tbody>
      </table></div>
    `}
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════════════════════

function UsersPanel() {
  const [users, setUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState({});
  const { names } = useNames();

  // Form state
  const [draftName, setDraftName] = useState("");
  const [draftPresets, setDraftPresets] = useState([]);
  const [draftPools, setDraftPools] = useState([]);

  async function load() { try { setUsers((await api("/v1/users")).users || []); } catch {} }
  useEffect(() => { load(); }, []);

  async function create() {
    setBusy(true);
    try {
      const res = await api("/v1/users", jpost({
        username: draftName || `user-${Date.now()}`,
        allowedPresets: draftPresets,
        allowedPools: draftPools,
      }));
      setRevealedKeys((k) => ({ ...k, [res.user.username]: res.user.key }));
      setShowForm(false); setDraftName(""); setDraftPresets([]); setDraftPools([]);
      await load();
    } finally { setBusy(false); }
  }

  async function toggleUser(u, enabled) { setBusy(true); try { await api(`/v1/users/${encodeURIComponent(u.username)}`, jput({ enabled })); await load(); } finally { setBusy(false); } }
  async function del(u) { if (!confirm(`Delete user "${u.username}"?`)) return; setBusy(true); try { await api(`/v1/users/${encodeURIComponent(u.username)}`, { method: "DELETE" }); await load(); } finally { setBusy(false); } }
  async function revealKey(username) {
    try {
      const d = await api(`/v1/users/${encodeURIComponent(username)}/key`);
      setRevealedKeys((k) => ({ ...k, [username]: d.key }));
    } catch {}
  }

  function copyKey(key) { navigator.clipboard.writeText(key); }

  const presetNames = (names?.providers || []).concat(names?.pools || []).concat(names?.chains || []);

  return html`<div>
    <div className="card-row" style=${{ marginBottom: "12px" }}>
      <h2 style=${{ margin: 0 }}>Users</h2>
      <div className="actions"><button className="btn" onClick=${load}>Refresh</button><button className="btn primary" onClick=${() => setShowForm((v) => !v)}>${showForm ? "Close" : "+ Add user"}</button></div>
    </div>
    <div style=${{ marginBottom: "6px", fontSize: "11px", color: "#52525b" }}>Stored in: ~/.pi/agent/multi-pass-users.json. Each user gets an API key for /ui and /v1 access.</div>

    ${showForm ? html`
      <div className="card" style=${{ marginBottom: "12px" }}>
        <div className="form-grid">
          <div><label>Username</label><input value=${draftName} onInput=${(e) => setDraftName(e.target.value)} placeholder="e.g. alice" /></div>
          <div><label>Allowed presets (empty = all)</label><input value=${draftPresets.join(", ")} onInput=${(e) => setDraftPresets(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder="coding-premium, fastest" /></div>
          <div><label>Allowed pools (empty = all)</label><input value=${draftPools.join(", ")} onInput=${(e) => setDraftPools(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder="codex-pool" /></div>
        </div>
        <div className="actions" style=${{ marginTop: "10px" }}><button className="btn primary" onClick=${create} disabled=${busy}>Create</button><button className="btn" onClick=${() => setShowForm(false)}>Cancel</button></div>
      </div>
    ` : null}

    ${users.length === 0 ? html`<div className="empty">No users. Admin token has full access. Create users to share access with restricted permissions.</div>` : null}

    ${users.map((u) => {
      const key = revealedKeys[u.username];
      return html`
        <div className="card" key=${u.username}>
          <div className="card-row">
            <div>
              <span className="name">${u.username}</span>
              <span className=${`badge ${u.enabled !== false ? "on" : "off"}`}>${u.enabled !== false ? "active" : "disabled"}</span>
              ${u.allowedPresets?.length ? html`<span className="badge neutral">presets: ${u.allowedPresets.join(", ")}</span>` : null}
              ${u.allowedPools?.length ? html`<span className="badge neutral">pools: ${u.allowedPools.join(", ")}</span>` : null}
              ${!u.allowedPresets?.length && !u.allowedPools?.length ? html`<span className="badge neutral">all access</span>` : null}
            </div>
            <div className="actions">
              ${key
                ? html`<span style=${{ fontFamily: "monospace", fontSize: "11px", color: "#f59e0b", cursor: "pointer", padding: "4px 8px", border: "1px solid #3f3f46", borderRadius: "6px" }} onClick=${() => copyKey(key)} title="Click to copy">${key.slice(0, 12)}... (click to copy)</span>`
                : html`<button className="btn" onClick=${() => revealKey(u.username)}>Show key</button>`
              }
              <button className="btn" disabled=${busy} onClick=${() => toggleUser(u, !(u.enabled !== false))}>${u.enabled !== false ? "Disable" : "Enable"}</button>
              <button className="btn danger" disabled=${busy} onClick=${() => del(u)}>Delete</button>
            </div>
          </div>
        </div>
      `;
    })}
  </div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// APP + LOGIN
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

  function logout() { localStorage.removeItem(TOKEN_KEY); location.reload(); }

  const tabs = ["dashboard", "config", "users", "rules", "audit"];

  return html`
    <div className="app">
      <div className="header">
        <div className="logo">Leeloo Admin</div>
        <a className="nav-link" href="/ui">Chat UI</a>
        <a className="nav-link" href="/health">Health</a>
        <div style=${{ flex: 1 }} />
        <button className="btn" onClick=${logout} style=${{ fontSize: "11px" }}>Logout</button>
      </div>
      <div className="tabs">${tabs.map((t) => html`<button key=${t} className=${`tab ${tab === t ? "active" : ""}`} onClick=${() => setTab(t)}>${t}</button>`)}</div>
      <div className="panel"><div className="panel-inner">
        ${error ? html`<div className="card" style=${{ color: "#ef4444", borderColor: "#7f1d1d" }}>Error: ${error}</div>` : null}
        ${tab === "dashboard" ? html`<${DashboardPanel} data=${dash} />` : null}
        ${tab === "config" ? html`<${ConfigPanel} onRefresh=${() => load("dashboard", true)} />` : null}
        ${tab === "users" ? html`<${UsersPanel} />` : null}
        ${tab === "rules" ? html`<${RulesPanel} rules=${rules} onRefresh=${() => load("rules")} />` : null}
        ${tab === "audit" ? html`<${AuditPanel} entries=${audit} onRefresh=${() => load("audit")} />` : null}
      </div></div>
    </div>
  `;
}

function LoginScreen({ onLogin }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!token.trim()) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`${BASE}/v1/auth/verify`, { method: "POST", headers: { Authorization: `Bearer ${token.trim()}` } });
      const d = await r.json();
      if (d.valid && d.role === "admin") { localStorage.setItem(TOKEN_KEY, token.trim()); onLogin(); }
      else if (d.valid) setError("Admin token required for admin panel");
      else setError("Invalid token");
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return html`
    <div style=${{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#09090b" }}>
      <div style=${{ width: "340px", padding: "32px", background: "#18181b", border: "1px solid #27272a", borderRadius: "16px" }}>
        <h2 style=${{ color: "#f59e0b", fontSize: "18px", fontWeight: 700, marginBottom: "4px" }}>Leeloo Admin</h2>
        <p style=${{ color: "#52525b", fontSize: "13px", marginBottom: "20px" }}>Enter the admin token to continue.</p>
        <input type="password" value=${token} onInput=${(e) => setToken(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter") submit(); }} placeholder="Admin token..." style=${{ width: "100%", marginBottom: "10px" }} autoFocus />
        ${error ? html`<div style=${{ color: "#ef4444", fontSize: "12px", marginBottom: "8px" }}>${error}</div>` : null}
        <button className="btn primary" onClick=${submit} disabled=${busy} style=${{ width: "100%" }}>${busy ? "Verifying..." : "Login"}</button>
      </div>
    </div>
  `;
}

function AuthGate() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (!t) { setChecking(false); return; }
    fetch(`${BASE}/v1/auth/verify`, { method: "POST", headers: { Authorization: `Bearer ${t}` } })
      .then((r) => r.json())
      .then((d) => { if (d.valid && d.role === "admin") setAuthed(true); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  if (checking) return html`<div style=${{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#09090b", color: "#52525b" }}>Loading...</div>`;
  if (!authed) return html`<${LoginScreen} onLogin=${() => setAuthed(true)} />`;
  return html`<${App} />`;
}

createRoot(document.getElementById("app")).render(html`<${AuthGate} />`);
