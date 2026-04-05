import React, { useCallback, useEffect, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";
import { marked } from "https://esm.sh/marked@12.0.2";
import hljs from "https://esm.sh/highlight.js@11.9.0/lib/core";
import javascript from "https://esm.sh/highlight.js@11.9.0/lib/languages/javascript";
import python from "https://esm.sh/highlight.js@11.9.0/lib/languages/python";
import bash from "https://esm.sh/highlight.js@11.9.0/lib/languages/bash";
import typescript from "https://esm.sh/highlight.js@11.9.0/lib/languages/typescript";
import json from "https://esm.sh/highlight.js@11.9.0/lib/languages/json";
import css from "https://esm.sh/highlight.js@11.9.0/lib/languages/css";
import xml from "https://esm.sh/highlight.js@11.9.0/lib/languages/xml";
import rust from "https://esm.sh/highlight.js@11.9.0/lib/languages/rust";
import cpp from "https://esm.sh/highlight.js@11.9.0/lib/languages/cpp";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("c", cpp);

marked.setOptions({
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true,
});

const html = htm.bind(React.createElement);
const BASE = location.origin;
const ROUTE_KEY = "leeloo.route";

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function routeLabel(id) { return id.replace("pool:", "").replace("provider:", "").replace("/", " / "); }

function qColor(s) { return s == null ? "#3f3f46" : s > 50 ? "#22c55e" : s > 20 ? "#eab308" : "#ef4444"; }

// ── Components ──

function TopBar({ groups, route, setRoute, onClear, status, busy }) {
  return html`
    <div className="topbar">
      <div className="logo">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        Leeloo
      </div>
      <select className="route-select" value=${route} onChange=${(e) => setRoute(e.target.value)} disabled=${busy || !groups.length}>
        ${groups.map((g) => html`
          <optgroup key=${g.label} label=${g.label}>
            ${g.items.map((it) => html`<option key=${it.id} value=${it.id}>${it.name}</option>`)}
          </optgroup>
        `)}
      </select>
      <button className="btn" onClick=${onClear} disabled=${busy}>Clear</button>
      <a className="btn" href="/admin">Admin</a>
      <div className="spacer" />
      <div className=${`status ${status.kind}`}>${status.text}</div>
    </div>
  `;
}

function InfoStrip({ health, quota }) {
  const providers = quota?.providers || [];
  const exhausted = new Set(health?.exhausted || []);
  return html`
    <div className="info-strip">
      <span>${health?.pools?.length || 0} pools</span>
      <span>${health?.presets?.length || 0} presets</span>
      <span>${health?.providers?.length || 0} providers</span>
      ${providers.map((p) => {
        const pct = p.score ?? 0;
        const exh = exhausted.has(p.provider);
        return html`
          <span key=${p.provider} className="quota-chip">
            ${p.label || p.provider}
            <span className="quota-bar"><span className="quota-fill" style=${{ width: `${pct}%`, background: qColor(p.score) }} /></span>
            <span style=${{ color: qColor(p.score) }}>${p.score == null ? "?" : `${p.score}%`}</span>
            ${exh ? html`<span style=${{ color: "#ef4444" }}> exh</span>` : null}
          </span>
        `;
      })}
    </div>
  `;
}

function Markdown({ content }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = marked.parse(content || "");
    ref.current.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "Copy";
      btn.onclick = () => {
        const code = pre.querySelector("code")?.textContent || pre.textContent;
        navigator.clipboard.writeText(code);
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
      };
      pre.style.position = "relative";
      pre.appendChild(btn);
    });
  }, [content]);
  return html`<div ref=${ref} />`;
}

function MessageCard({ m }) {
  const isUser = m.role === "user";
  return html`
    <div className=${`msg ${m.role}`}>
      <div className=${`msg-header ${m.role}`}>${isUser ? "You" : "Assistant"}</div>
      <div className=${`msg-body ${m.error ? "error" : ""}`}>
        ${m.thinking
          ? html`<div className="thinking"><div className="thinking-dots"><span /><span /><span /></div> Thinking...</div>`
          : isUser
            ? html`<div style=${{ whiteSpace: "pre-wrap" }}>${m.content}</div>`
            : html`<${Markdown} content=${m.content} />`
        }
      </div>
      ${m.meta ? html`
        <div className="msg-meta">
          ${m.metaParts?.map((p, i) => html`<span key=${i} className=${`meta-tag ${p.type}`}>${p.text}</span>`)}
        </div>
      ` : null}
    </div>
  `;
}

function Composer({ input, setInput, onSend, disabled }) {
  const ref = useRef(null);

  const autoResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  useEffect(() => { autoResize(); }, [input]);

  return html`
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-wrap">
          <textarea
            ref=${ref}
            value=${input}
            onInput=${(e) => setInput(e.target.value)}
            placeholder="Message Leeloo..."
            disabled=${disabled}
            rows="1"
            onKeyDown=${(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
            }}
          />
        </div>
        <button className="btn send" onClick=${onSend} disabled=${disabled || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  `;
}

// ── App ──

function App() {
  const [groups, setGroups] = useState([]);
  const [route, setRoute] = useState(() => localStorage.getItem(ROUTE_KEY) || "");
  const [health, setHealth] = useState(null);
  const [quota, setQuota] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState({ kind: "", text: "loading..." });
  const chatRef = useRef(null);
  const convoRef = useRef([]);
  const bottomRef = useRef(null);

  useEffect(() => { loadRouting(); loadInfo(); const t = setInterval(() => loadInfo(true), 12000); return () => clearInterval(t); }, []);
  useEffect(() => { if (route) localStorage.setItem(ROUTE_KEY, route); }, [route]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  async function loadRouting() {
    try {
      const { groups: gs = [] } = await fetch(`${BASE}/v1/routing`).then((r) => r.json());
      setGroups(gs);
      const flat = gs.flatMap((g) => g.items || []);
      const ids = new Set(flat.map((x) => x.id));
      setRoute((prev) => (prev && ids.has(prev) ? prev : flat[0]?.id || ""));
      setStatus({ kind: "", text: `${flat.length} routes` });
    } catch (e) { setStatus({ kind: "error", text: e.message }); }
  }

  async function loadInfo(silent) {
    const [h, q] = await Promise.allSettled([
      fetch(`${BASE}/health`).then((r) => r.json()),
      fetch(`${BASE}/v1/quota`).then((r) => r.json()),
    ]);
    if (h.status === "fulfilled") setHealth(h.value);
    if (q.status === "fulfilled") setQuota(q.value);
  }

  function clearChat() { convoRef.current = []; setMessages([]); }

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming || !route) return;
    convoRef.current.push({ role: "user", content: text });

    const aid = `a-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", content: text }, { id: aid, role: "assistant", content: "", thinking: true }]);
    setInput("");
    setStreaming(true);
    setStatus({ kind: "busy", text: "streaming..." });

    const t0 = Date.now();
    let full = "", usage = null, xProvider = "", xModel = "", xLabel = "";
    let raf = false;
    const flush = () => { if (raf) return; raf = true; requestAnimationFrame(() => { raf = false; setMessages((p) => p.map((m) => m.id === aid ? { ...m, content: full, thinking: false } : m)); }); };

    try {
      const resp = await fetch(`${BASE}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: route, messages: convoRef.current, stream: true }) });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e?.error?.message || `HTTP ${resp.status}`); }

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const p = line.slice(6).trim();
          if (p === "[DONE]") continue;
          let j; try { j = JSON.parse(p); } catch { continue; }
          const d = j.choices?.[0]?.delta;
          if (d?.content) { full += d.content; flush(); }
          if (d?.tool_calls?.length) { full += `\n**Tool:** \`${d.tool_calls[0]?.function?.name || "?"}\`\n`; flush(); }
          if (j.usage) usage = j.usage;
          if (j.x_provider) xProvider = j.x_provider;
          if (j.x_model) xModel = j.x_model;
          if (j.x_label) xLabel = j.x_label;
        }
      }

      convoRef.current.push({ role: "assistant", content: full });
      const dur = ((Date.now() - t0) / 1000).toFixed(1) + "s";
      const metaParts = [
        { type: "route", text: routeLabel(route) },
        ...(xLabel || xProvider ? [{ type: "provider", text: `${xLabel || xProvider} / ${xModel}` }] : []),
        ...(usage ? [{ type: "tokens", text: `${usage.prompt_tokens} in / ${usage.completion_tokens} out` }] : []),
        { type: "time", text: dur },
      ];
      setMessages((p) => p.map((m) => m.id === aid ? { ...m, content: full || "(empty)", thinking: false, meta: true, metaParts } : m));
      setStatus({ kind: "", text: "done" });
      loadInfo(true);
    } catch (e) {
      const last = convoRef.current[convoRef.current.length - 1];
      if (last?.role === "user" && last.content === text) convoRef.current.pop();
      setMessages((p) => p.map((m) => m.id === aid ? { ...m, content: `Error: ${e.message}`, thinking: false, error: true } : m));
      setStatus({ kind: "error", text: e.message });
    } finally { setStreaming(false); }
  }

  return html`
    <div className="app">
      <${TopBar} groups=${groups} route=${route} setRoute=${setRoute} onClear=${clearChat} status=${status} busy=${streaming} />
      <${InfoStrip} health=${health} quota=${quota} />
      <div className="chat" ref=${chatRef}>
        <div className="chat-inner">
          ${!messages.length ? html`<div className="welcome"><h2>Leeloo on multi-pass</h2><p>Send a message to test routing, pools, presets, and rules.</p></div>` : null}
          ${messages.map((m) => html`<${MessageCard} key=${m.id} m=${m} />`)}
          <div ref=${bottomRef} />
        </div>
      </div>
      <${Composer} input=${input} setInput=${setInput} onSend=${sendMessage} disabled=${streaming} />
    </div>
  `;
}

createRoot(document.getElementById("app")).render(html`<${App} />`);
