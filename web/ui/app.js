import React, { useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const BASE = location.origin;

function routeLabel(id) {
  return id.replace("pool:", "").replace("provider:", "").replace("/", " / ");
}

function quotaClass(score) {
  if (score == null) return "pill";
  if (score > 50) return "pill ok";
  if (score > 20) return "pill warn";
  return "pill bad";
}

function TopBar({ groups, selectedRoute, setSelectedRoute, onClear, status, loading }) {
  return html`
    <div className="topbar">
      <div className="title">Leeloo</div>
      <select
        className="route-select"
        value=${selectedRoute || ""}
        onChange=${(e) => setSelectedRoute(e.target.value)}
        disabled=${loading || groups.length === 0}
      >
        ${groups.map((g) => html`
          <optgroup key=${g.label} label=${g.label}>
            ${g.items.map((it) => html`<option key=${it.id} value=${it.id}>${it.name}</option>`) }
          </optgroup>
        `)}
      </select>
      <button className="btn" onClick=${onClear} disabled=${loading}>Clear</button>
      <a className="btn" href="/admin">Admin</a>
      <div className=${`status ${status.kind}`}>${status.text}</div>
    </div>
  `;
}

function InfoStrip({ health, quota }) {
  const providers = quota?.providers || [];
  const exhausted = new Set(health?.exhausted || []);
  return html`
    <div className="info-strip">
      <span>Pools: ${health?.pools?.length || 0}</span>
      <span>Presets: ${health?.presets?.length || 0}</span>
      <span>Providers: ${health?.providers?.length || 0}</span>
      ${providers.map((p) => html`
        <span key=${p.provider} className=${quotaClass(p.score)}>
          ${p.label || p.provider}: ${p.score == null ? "?" : `${p.score}%`}
          ${exhausted.has(p.provider) ? " (exhausted)" : ""}
        </span>
      `)}
    </div>
  `;
}

function MessageCard({ m }) {
  return html`
    <div className=${`msg ${m.role}`}>
      <div className=${`body ${m.error ? "error" : ""}`}>
        ${m.thinking ? html`<span className="thinking"><span className="dots"><span>.</span><span>.</span><span>.</span></span> Thinking...</span>` : m.content}
      </div>
      ${m.meta ? html`<div className="meta">${m.meta}</div>` : null}
    </div>
  `;
}

function Composer({ input, setInput, onSend, disabled }) {
  return html`
    <div className="composer">
      <div style=${{ flex: 1 }}>
        <textarea
          value=${input}
          onInput=${(e) => setInput(e.target.value)}
          placeholder="Ask something..."
          disabled=${disabled}
          onKeyDown=${(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className="footer-note">Enter to send, Shift+Enter for newline.</div>
      </div>
      <button className="btn" onClick=${onSend} disabled=${disabled || !input.trim()}>Send</button>
    </div>
  `;
}

function App() {
  const [groups, setGroups] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState("");
  const [health, setHealth] = useState(null);
  const [quota, setQuota] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState({ kind: "", text: "loading..." });

  const chatRef = useRef(null);
  const convoRef = useRef([]);

  useEffect(() => {
    loadRouting();
    loadInfo();
  }, []);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  async function loadRouting() {
    try {
      const data = await fetch(`${BASE}/v1/routing`).then((r) => r.json());
      const gs = data?.groups || [];
      setGroups(gs);
      const first = gs.flatMap((g) => g.items || [])[0]?.id || "";
      setSelectedRoute((prev) => prev || first);
      setStatus({ kind: "", text: `${gs.flatMap((g) => g.items || []).length} routes` });
    } catch (e) {
      setStatus({ kind: "error", text: `routing failed: ${e.message}` });
    }
  }

  async function loadInfo() {
    try {
      const [h, q] = await Promise.all([
        fetch(`${BASE}/health`).then((r) => r.json()),
        fetch(`${BASE}/v1/quota`).then((r) => r.json()),
      ]);
      setHealth(h);
      setQuota(q);
    } catch {
      // best-effort
    }
  }

  function clearChat() {
    convoRef.current = [];
    setMessages([]);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming || !selectedRoute) return;

    const userTurn = { role: "user", content: text };
    convoRef.current.push(userTurn);

    const aid = `a-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", content: text },
      { id: aid, role: "assistant", content: "", thinking: true },
    ]);

    setInput("");
    setStreaming(true);
    setStatus({ kind: "busy", text: "connecting..." });

    const t0 = Date.now();
    let full = "";
    let usage = null;
    let xProvider = "";
    let xModel = "";
    let xLabel = "";

    try {
      const resp = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedRoute,
          messages: convoRef.current,
          stream: true,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err?.error?.message || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          let j;
          try { j = JSON.parse(payload); }
          catch { continue; }

          const d = j.choices?.[0]?.delta;
          if (d?.content) {
            full += d.content;
            setMessages((prev) => prev.map((m) =>
              m.id === aid ? { ...m, content: full, thinking: false } : m
            ));
          }

          if (d?.tool_calls?.length) {
            const tc = d.tool_calls[0];
            const textPart = `\n[Tool call: ${tc?.function?.name || "?"}]\n`;
            full += textPart;
            setMessages((prev) => prev.map((m) =>
              m.id === aid ? { ...m, content: full, thinking: false } : m
            ));
          }

          if (j.usage) usage = j.usage;
          if (j.x_provider) xProvider = j.x_provider;
          if (j.x_model) xModel = j.x_model;
          if (j.x_label) xLabel = j.x_label;
        }
      }

      convoRef.current.push({ role: "assistant", content: full });
      const duration = ((Date.now() - t0) / 1000).toFixed(1) + "s";
      const parts = [];
      parts.push(routeLabel(selectedRoute));
      if (xLabel || xProvider) parts.push(`${xLabel || xProvider} / ${xModel}`);
      if (usage) parts.push(`${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
      parts.push(duration);

      setMessages((prev) => prev.map((m) =>
        m.id === aid
          ? { ...m, content: full || "(empty)", thinking: false, meta: parts.join(" | ") }
          : m
      ));

      setStatus({ kind: "", text: "done" });
      loadInfo();
    } catch (e) {
      const last = convoRef.current[convoRef.current.length - 1];
      if (last && last.role === "user" && last.content === text) convoRef.current.pop();
      setMessages((prev) => prev.map((m) =>
        m.id === aid
          ? { ...m, content: `[Error: ${e.message}]`, thinking: false, error: true }
          : m
      ));
      setStatus({ kind: "error", text: e.message });
    } finally {
      setStreaming(false);
    }
  }

  const hasMessages = messages.length > 0;

  return html`
    <div className="app">
      <${TopBar}
        groups=${groups}
        selectedRoute=${selectedRoute}
        setSelectedRoute=${setSelectedRoute}
        onClear=${clearChat}
        status=${status}
        loading=${streaming}
      />
      <${InfoStrip} health=${health} quota=${quota} />
      <div className="chat" ref=${chatRef}>
        ${!hasMessages ? html`<div className="welcome"><h2>Leeloo on multi-pass</h2><p>Start chatting to test routes, pools and rules.</p></div>` : null}
        ${messages.map((m) => html`<${MessageCard} key=${m.id} m=${m} />`)}
      </div>
      <${Composer}
        input=${input}
        setInput=${setInput}
        onSend=${sendMessage}
        disabled=${streaming}
      />
    </div>
  `;
}

createRoot(document.getElementById("app")).render(html`<${App} />`);
