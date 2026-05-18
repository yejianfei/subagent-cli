// HTML templates for the debug viewer. Kept in a dedicated file so app.ts
// stays focused on routing and lifecycle, and the markup is easy to iterate on.

export function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function renderSessionRow(args: {
  id: string
  subagent: string
  cwd: string
  role: string
  state: string
  lastAt: number
  closed: boolean
}): string {
  const sid = args.id.slice(0, 8)
  const link = `<a href="/viewer?session=${escapeHtml(args.id)}" target="_blank">${escapeHtml(sid)}</a>`
  const ts = args.lastAt > 0 ? String(args.lastAt) : ''
  const state = args.state || (args.closed ? 'CLOSED' : '')
  const stateClass = `state state-${state.toLowerCase()}`
  return `<tr class="${args.closed ? 'closed' : ''}"><td>${escapeHtml(args.subagent || 'unknown')}</td><td>${link}</td><td>${escapeHtml(args.cwd || '')}</td><td>${escapeHtml(args.role || '')}</td><td class="ts" data-ts="${ts}"></td><td><span class="${stateClass}">${escapeHtml(state)}</span></td></tr>`
}

export function renderViewerIndex(rows: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sessions</title><style>
body{font-family:'SF Mono','Fira Code',monospace;margin:24px;color:#222}
h1{font-size:16px;display:flex;align-items:center;justify-content:space-between;margin:0 0 16px}
.refresh{background:transparent;border:0;cursor:pointer;font:18px monospace;padding:2px 8px;border-radius:4px;color:#555}
.refresh:hover{background:rgba(0,0,0,0.08)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 12px;text-align:left;border-bottom:1px solid #eee}
th{font-weight:600;color:#555;background:#fafafa}
tr.closed{opacity:0.5}
td.ts{color:#888;white-space:nowrap}
.state{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#eee;color:#555}
.state-idle{background:#e6f7ed;color:#1d6f42}
.state-running,.state-pending{background:#fff4cc;color:#7a5a00}
.state-asking{background:#ffe6e6;color:#a04040}
.state-opening,.state-initing{background:#e6efff;color:#3a5fa0}
.state-closed{background:#ececec;color:#888}
a{color:#7B61FF;text-decoration:none}
a:hover{text-decoration:underline}
.empty{color:#888;padding:24px 0;text-align:center}
</style></head><body>
<h1><span>Sessions</span><button class="refresh" title="Refresh" onclick="location.reload()">&#8635;</button></h1>
${rows ? `<table><thead><tr><th>Subagent</th><th>Session</th><th>CWD</th><th>Role</th><th>Last activity</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">No sessions</div>'}
<script>
function fmtAgo(ms){
  if(!ms) return ''
  const d = Date.now() - ms
  if(d < 60000) return Math.floor(d/1000) + 's ago'
  if(d < 3600000) return Math.floor(d/60000) + 'm ago'
  if(d < 86400000) return Math.floor(d/3600000) + 'h ago'
  return new Date(ms).toLocaleString()
}
function paintTs(){ document.querySelectorAll('td.ts').forEach(td => { td.textContent = fmtAgo(Number(td.dataset.ts) || 0) }) }
paintTs()
setInterval(()=>{ if(document.visibilityState==='visible') location.reload() }, 5000)
setInterval(paintTs, 1000)
</script>
</body></html>`
}

export const VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>subagent-cli debug viewer</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; font-family: 'SF Mono', 'Fira Code', monospace; height: 100vh; display: flex; flex-direction: column; }
    .header { background: #16213e; color: #7B61FF; padding: 8px 16px; font-size: 13px; border-bottom: 1px solid #0f3460; display: flex; align-items: center; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #00ff88; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
    #terminal { flex: 1; padding: 4px; }
  </style>
</head>
<body>
  <div class="header"><span class="dot"></span> subagent-cli debug viewer — session: <span id="sid"></span></div>
  <div id="terminal"></div>
  <script type="module">
    import { Terminal } from 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm'
    import * as FitAddon from 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm'
    const session = new URLSearchParams(location.search).get('session') || 'unknown'
    document.getElementById('sid').textContent = session
    const term = new Terminal({
      theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#7B61FF' },
      fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 13,
      cursorBlink: true, scrollback: 10000,
    })
    const fitAddon = new FitAddon.FitAddon()
    term.loadAddon(fitAddon)
    term.open(document.getElementById('terminal'))
    let ws
    // Server uses these close codes to tell us the connection is permanently dead.
    // 4001 = session closed; 4003 = window mismatch; 4004 = session not found.
    // Reconnecting against any of them is pointless — show a final state instead.
    const TERMINAL_CODES = { 4001: 'session closed', 4003: 'access denied (different window)', 4004: 'session not found' }
    function connect() {
      ws = new WebSocket('ws://' + location.host + '/ws?session=' + session)
      ws.onopen = () => { const dot = document.querySelector('.dot'); dot.style.background = '#44ff44'; dot.style.animation = 'pulse 2s infinite'; fitAddon.fit(); sendResize() }
      ws.onmessage = (e) => term.write(e.data)
      ws.onclose = (e) => {
        const dot = document.querySelector('.dot')
        dot.style.background = '#ff4444'
        dot.style.animation = 'none'
        const fatal = TERMINAL_CODES[e.code]
        if (fatal) { term.write('\\r\\n\\x1b[31m[' + fatal + ']\\x1b[0m\\r\\n'); return }
        term.write('\\r\\n\\x1b[33m[reconnecting...]\\x1b[0m\\r\\n')
        setTimeout(connect, 2000)
      }
    }
    connect()
    term.onData((data) => { if (ws && ws.readyState === 1) ws.send(data) })
    function sendResize() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })) }
    term.onResize(() => sendResize())
    window.addEventListener('resize', () => fitAddon.fit())
    term.focus()
  </script>
</body>
</html>`
