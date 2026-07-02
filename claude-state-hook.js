#!/usr/bin/env node
/**
 * claude-state-hook.js — cross-platform (Windows + Linux + macOS)
 *
 * Stato PER-SESSIONE: scrive in <tmpdir>/claude-semaforo/<hash(cwd)>/<session_id>.json,
 * così più sessioni Claude (anche nella stessa cartella/finestra) restano
 * indipendenti. Su SessionEnd il file della sessione viene rimosso.
 * Scrive anche <tmpdir>/claude-code-state.json (legacy) come fallback per
 * finestre senza workspace. L'estensione "Claude Status" aggrega le sessioni.
 *
 * <tmpdir> = os.tmpdir():
 *   - Windows -> %TEMP%  (es. C:\Users\<tu>\AppData\Local\Temp)
 *   - Linux   -> /tmp
 *   - macOS   -> /var/folders/...
 *
 * Evento, tool e cwd vengono determinati (in ordine di priorità) da:
 *   1. il JSON passato da Claude Code su stdin -> "hook_event_name" / "tool_name" / "cwd"
 *   2. gli argomenti CLI (es. `node claude-state-hook.js PreToolUse AskUserQuestion`)
 *   3. le variabili d'ambiente CLAUDE_HOOK_EVENT / TOOL_NAME e process.cwd()
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LEGACY_FILE = path.join(os.tmpdir(), 'claude-code-state.json');
const STATE_DIR = path.join(os.tmpdir(), 'claude-semaforo');

// Chiave stabile per la cartella di lavoro (deve combaciare con l'estensione).
function keyForPath(p) {
  let norm = path.resolve(p || '.').replace(/\\/g, '/');
  if (process.platform === 'win32') norm = norm.toLowerCase(); // FS case-insensitive
  return crypto.createHash('md5').update(norm).digest('hex').slice(0, 16);
}

// Tool che rappresentano un'attesa di input da parte tua -> 🟠 arancio.
const WAITING_TOOLS = new Set(['AskUserQuestion']);

// Eventi hook riconosciuti (per il parsing robusto degli argomenti CLI).
const KNOWN_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'
]);

// Chiave file per una sessione (session_id di Claude Code, ripulito).
function sessionKeyFrom(id) {
  const s = String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return s || 'default';
}

function readPayload() {
  // 1. stdin JSON — contratto ufficiale degli hook di Claude Code.
  //    Salta la lettura se stdin è un terminale interattivo (evita blocchi).
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(0, 'utf8');
      if (raw && raw.trim()) {
        const data = JSON.parse(raw);
        if (data && data.hook_event_name) {
          return {
            event: String(data.hook_event_name),
            tool: String(data.tool_name || ''),
            cwd: String(data.cwd || process.cwd()),
            session: String(data.session_id || ''),
          };
        }
      }
    } catch { /* stdin vuoto o non-JSON: passa ai fallback */ }
  }

  // 2. argomenti CLI — slice(1) copre sia `node script.js Evento [Tool]`
  //    sia `node -e "..." Evento [Tool]` (dove gli arg partono da argv[1]).
  const args = process.argv.slice(1);
  const event = args.find(a => KNOWN_EVENTS.has(a)) || process.env.CLAUDE_HOOK_EVENT || '';
  const tool = args.find(a => WAITING_TOOLS.has(a)) || process.env.TOOL_NAME || '';

  // 3. variabili d'ambiente / cwd del processo come ultimo fallback
  return {
    event, tool,
    cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    session: process.env.CLAUDE_SESSION_ID || '',
  };
}

const { event, tool, cwd, session } = readPayload();

// Ogni sessione Claude ha il proprio file, in una sottocartella per-progetto:
//   <tmpdir>/claude-semaforo/<hash(cwd)>/<session_id>.json
// Così più sessioni nella stessa cartella/finestra restano indipendenti.
const cwdDir = path.join(STATE_DIR, keyForPath(cwd));
const sessionFile = path.join(cwdDir, sessionKeyFrom(session) + '.json');

// A fine sessione, rimuovi il suo file: sparisce dal semaforo.
if (event === 'SessionEnd') {
  try { fs.unlinkSync(sessionFile); } catch { /* già assente */ }
  process.exit(0);
}

let status = 'idle';
if (event === 'SessionStart') {
  status = 'idle';          // 🟢 sessione appena avviata: pronto
} else if (event === 'UserPromptSubmit') {
  status = 'working';       // 🔴 hai inviato un prompt: Claude parte subito
} else if (event === 'PermissionRequest') {
  status = 'waiting';       // 🟠 Claude aspetta che tu approvi/neghi un tool
} else if (event === 'PreToolUse') {
  // 🟠 se Claude sta per farti una domanda a scelta; 🔴 per ogni altro tool
  status = WAITING_TOOLS.has(tool) ? 'waiting' : 'working';
} else if (event === 'PostToolUse') {
  status = 'working';       // 🔴 tool completato (anche la domanda risposta): Claude elabora
} else if (event === 'Notification') {
  status = 'waiting';       // 🟠 Claude aspetta conferma o input (permesso / idle)
} else if (event === 'Stop') {
  status = 'idle';          // 🟢 turno finito, puoi scrivere
} else if (event === 'SubagentStop') {
  status = 'working';       // 🔴 subagente finito, il turno principale continua
}

const nowMs = Date.now();
const payload = JSON.stringify({
  status,
  event,
  tool,
  cwd,
  timestamp: new Date(nowMs).toISOString()
});

// Scrittura con GUARDIA MONOTONICA: gli hook sono processi node separati e
// l'ordine di scrittura può invertirsi rispetto all'ordine degli eventi (es.
// PostToolUse che scrive dopo Stop → il file resterebbe su "working"/rosso).
// Non sovrascriviamo mai un record con timestamp più recente del nostro.
function writeState(file) {
  try {
    const prevTs = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).timestamp);
    if (!isNaN(prevTs) && prevTs > nowMs) { return; } // sul disco c'è già qualcosa di più recente
  } catch { /* file assente o illeggibile: procedi */ }
  fs.writeFileSync(file, payload, 'utf8');
}

// File PER-SESSIONE: <tmpdir>/claude-semaforo/<hash(cwd)>/<session>.json
try {
  fs.mkdirSync(cwdDir, { recursive: true });
  writeState(sessionFile);
} catch (e) {
  process.stderr.write(`claude-state-hook (per-sessione) error: ${e.message}\n`);
}

// File LEGACY condiviso: fallback per finestre senza workspace corrispondente.
try {
  writeState(LEGACY_FILE);
} catch (e) {
  process.stderr.write(`claude-state-hook (legacy) error: ${e.message}\n`);
}
