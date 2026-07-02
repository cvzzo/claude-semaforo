import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';

// ── Tipi di stato ──────────────────────────────────────────────────────────
type SemaforoState = 'working' | 'waiting' | 'idle' | 'offline';

interface StateInfo {
  icon: string;
  label: string;
  color: vscode.ThemeColor;
  tooltip: string;
}

const STATES: Record<SemaforoState, StateInfo> = {
  working: {
    icon: '$(loading~spin)',
    label: '🔴 Claude working…',
    color: new vscode.ThemeColor('statusBarItem.errorBackground'),
    tooltip: 'Claude Code is processing — please wait',
  },
  waiting: {
    icon: '$(bell)',
    label: '🟠 Claude needs you',
    color: new vscode.ThemeColor('statusBarItem.warningBackground'),
    tooltip: 'Claude Code is waiting for your confirmation or input',
  },
  idle: {
    icon: '$(check)',
    label: '🟢 Claude ready',
    color: new vscode.ThemeColor('statusBarItem.prominentBackground'),
    tooltip: 'You can type a new prompt',
  },
  offline: {
    icon: '$(circle-slash)',
    label: '⚪ Claude offline',
    color: new vscode.ThemeColor('statusBarItem.remoteBackground'),
    tooltip: 'Claude Code is not active',
  },
};

// ── Percorsi file di stato di Claude Code ─────────────────────────────────
const STATE_DIR = path.join(os.tmpdir(), 'claude-semaforo');

// Chiave stabile per una cartella (deve combaciare con claude-state-hook.js).
function keyForPath(p: string): string {
  let norm = path.resolve(p).replace(/\\/g, '/');
  if (process.platform === 'win32') { norm = norm.toLowerCase(); }
  return crypto.createHash('md5').update(norm).digest('hex').slice(0, 16);
}

// Cartelle di stato per la finestra corrente: una sottocartella per ogni
// workspace folder (l'hook scrive <STATE_DIR>/<hash(cwd)>/<session>.json).
// Senza workspace, usa il file legacy globale come sessione singola.
function sessionDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .map(f => path.join(STATE_DIR, keyForPath(f.uri.fsPath)));
}
const LEGACY_FILE = path.join(os.tmpdir(), 'claude-code-state.json');

// ── Lettura stato di UNA sessione ──────────────────────────────────────────
interface Session { key: string; state: SemaforoState; stale: boolean; }

function parseStateFile(filePath: string): { status: SemaforoState; event: string; ageMs: number } | null {
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8').trim());
    const s = (json.status ?? json.state ?? '').toLowerCase();
    let status: SemaforoState | null = null;
    if (s.includes('think') || s.includes('work') || s.includes('run') || s === 'busy') { status = 'working'; }
    else if (s.includes('wait') || s.includes('confirm') || s.includes('input')) { status = 'waiting'; }
    else if (s === 'idle' || s === 'ready' || s === 'done') { status = 'idle'; }
    if (!status) { return null; }
    const ts = Date.parse(json.timestamp ?? '');
    const ageMs = isNaN(ts) ? 0 : Math.max(0, Date.now() - ts);
    return { status, event: String(json.event ?? ''), ageMs };
  } catch {
    return null;
  }
}

// Rete di sicurezza per le interruzioni (Esc non emette hook): se "working"
// non si aggiorna da troppo tempo E non c'è un tool in esecuzione (PreToolUse),
// lo consideriamo terminato → idle. Un tool lungo (build) resta invece rosso.
function resolveSessionState(raw: { status: SemaforoState; event: string; ageMs: number }, timeoutSec: number): { state: SemaforoState; stale: boolean } {
  if (raw.status !== 'working') { return { state: raw.status, stale: false }; }
  if (timeoutSec > 0 && raw.event !== 'PreToolUse' && raw.ageMs > timeoutSec * 1000) {
    return { state: 'idle', stale: true };
  }
  return { state: 'working', stale: false };
}

// Legge TUTTE le sessioni della finestra corrente (una per file).
function readSessions(): Session[] {
  const cfg = vscode.workspace.getConfiguration('claudeSemaforo');
  const timeoutSec = cfg.get<number>('staleWorkingTimeoutSeconds', 120);
  const deadMin = cfg.get<number>('sessionTimeoutMinutes', 60);
  const out: Session[] = [];
  const dirs = sessionDirs();

  if (dirs.length > 0) {
    for (const dir of dirs) {
      let files: string[] = [];
      try { files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        const raw = parseStateFile(path.join(dir, f));
        if (!raw) { continue; }
        // Scarta le sessioni "morte" (crash senza SessionEnd): nessun aggiornamento da troppo.
        if (deadMin > 0 && raw.ageMs > deadMin * 60 * 1000) { continue; }
        const r = resolveSessionState(raw, timeoutSec);
        out.push({ key: `${dir}/${f}`, state: r.state, stale: r.stale });
      }
    }
  } else {
    // Nessun workspace aperto: usa il file legacy globale come sessione unica.
    const raw = parseStateFile(LEGACY_FILE);
    if (raw) {
      const r = resolveSessionState(raw, timeoutSec);
      out.push({ key: 'legacy', state: r.state, stale: r.stale });
    }
  }
  // Ordine stabile (per chiave) → numerazione dei pallini coerente tra i refresh.
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

// Stato aggregato per il beacon: mostra il più URGENTE (chi aspetta te vince).
function aggregateState(sessions: Session[]): SemaforoState {
  if (sessions.some(s => s.state === 'waiting')) { return 'waiting'; }
  if (sessions.some(s => s.state === 'working')) { return 'working'; }
  if (sessions.some(s => s.state === 'idle')) { return 'idle'; }
  return 'offline';
}

// ── HTML del semaforo (usato dalla vista laterale) ────────────────────────
// `aggregate` = stato più urgente (colore del beacon); `sessions` = stato di
// ogni sessione Claude aperta (un pallino ciascuno).
function getSemaforoHtml(aggregate: SemaforoState, sessions: SemaforoState[]): string {
  const S: Record<SemaforoState, { color: string; msg: string; sub: string }> = {
    working: { color: '#ff453a', msg: 'Claude is working', sub: 'Processing — please wait' },
    waiting: { color: '#ff9f0a', msg: 'Claude needs you', sub: 'Waiting for your input' },
    idle: { color: '#30d158', msg: 'Ready', sub: 'You can type a new prompt' },
    offline: { color: '#8e8e93', msg: 'Claude Code is offline', sub: 'No active session here' },
  };
  const agg = S[aggregate];
  const dotClass: Record<SemaforoState, string> = { working: 'red', waiting: 'amber', idle: 'green', offline: 'grey' };
  const n = sessions.length;

  let label = agg.msg;
  let sub = agg.sub;
  if (n === 0) {
    label = S.offline.msg; sub = S.offline.sub;
  } else if (n > 1) {
    const c: Record<string, number> = { waiting: 0, working: 0, idle: 0 };
    sessions.forEach(st => { if (st in c) { c[st]++; } });
    const words: Record<string, string> = { waiting: 'waiting', working: 'working', idle: 'ready' };
    const parts = (['waiting', 'working', 'idle'] as const).filter(k => c[k] > 0).map(k => `${c[k]} ${words[k]}`);
    sub = `${n} sessions · ${parts.join(' · ')}`;
  }
  const word: Record<SemaforoState, string> = { working: 'working', waiting: 'needs you', idle: 'ready', offline: 'offline' };
  const dots = sessions.map((st, i) => {
    const num = sessions.length > 1 ? `<span class="n">${i + 1}</span>` : '';
    return `<span class="chip" title="Session ${i + 1}: ${word[st]}"><span class="d ${dotClass[st]}"></span>${num}</span>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Status</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --red: #ff453a; --amber: #ff9f0a; --green: #30d158; --grey: #8e8e93;
    --glow: ${agg.color};
  }
  /* Sfondo trasparente: eredita il tema di VSCode. */
  html, body { background: transparent; }
  body {
    color: var(--vscode-foreground, #e9e9ea);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: clamp(14px, 5vw, 24px);
    padding: 24px 16px;
    user-select: none;
  }

  .title {
    font-size: 0.62rem;
    letter-spacing: 0.24em;
    text-transform: uppercase;
    font-weight: 600;
    text-align: center;
    opacity: 0.5;
  }

  /* Beacon: una sola grande luce che domina il pannello. */
  .beacon {
    position: relative;
    width: clamp(88px, 54vw, 168px);
    aspect-ratio: 1 / 1;
    border-radius: 50%;
    background: radial-gradient(circle at 38% 32%,
      color-mix(in srgb, var(--glow) 72%, #fff) 0%,
      var(--glow) 46%,
      color-mix(in srgb, var(--glow) 58%, #000) 100%);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--glow) 45%, #000) inset,
      0 3px 10px rgba(255,255,255,0.28) inset,
      0 6px 16px rgba(0,0,0,0.28),
      0 0 22px var(--glow),
      0 0 55px color-mix(in srgb, var(--glow) 60%, transparent),
      0 0 110px color-mix(in srgb, var(--glow) 38%, transparent);
    animation: pulse 2.8s ease-in-out infinite;
  }
  /* Riflesso speculare */
  .beacon::after {
    content: '';
    position: absolute;
    top: 12%; left: 20%;
    width: 40%; height: 30%;
    border-radius: 50%;
    background: radial-gradient(circle at 50% 50%, rgba(255,255,255,0.6), rgba(255,255,255,0) 70%);
  }

  /* Animazioni per stato:
     - waiting (🟠): LAMPEGGIA per attirare l'attenzione (Claude ti aspetta)
     - working (🔴): "respiro" gentile (sta lavorando, nessuna azione richiesta)
     - idle (🟢) / offline (⚪): ferma */
  body.state-waiting .beacon { animation: blink 1.1s ease-in-out infinite; }
  body.state-idle .beacon    { animation: none; }

  /* Stato offline: luce spenta, neutra, ferma. */
  body.state-offline .beacon {
    animation: none;
    background: radial-gradient(circle at 40% 35%, #55555b 0%, #3a3a40 68%, #2a2a2f 100%);
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.06) inset,
      0 -3px 8px rgba(0,0,0,0.5) inset,
      0 3px 8px rgba(0,0,0,0.25);
  }
  body.state-offline .beacon::after { opacity: 0.25; }

  @keyframes pulse {
    0%, 100% { transform: scale(1);     filter: brightness(0.98); }
    50%      { transform: scale(1.015); filter: brightness(1.12); }
  }
  @keyframes blink {
    0%, 100% { opacity: 1;    filter: brightness(1.15); }
    50%      { opacity: 0.32; filter: brightness(0.7); }
  }
  @media (prefers-reduced-motion: reduce) {
    .beacon { animation: none !important; }
  }

  /* Pallini: uno per sessione Claude aperta, colore = stato della sessione,
     con mini-etichetta numerata (mostrata solo con più sessioni). */
  .dots { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 12px; max-width: 220px; }
  .dots:empty { display: none; }
  .dots .chip { display: inline-flex; align-items: center; gap: 5px; }
  .dots .n { font-size: 0.72rem; opacity: 0.6; font-variant-numeric: tabular-nums; }
  .dots .d { width: 10px; height: 10px; border-radius: 50%; }
  .dots .d.red   { background: var(--red);   box-shadow: 0 0 8px var(--red); }
  .dots .d.amber { background: var(--amber); box-shadow: 0 0 8px var(--amber); animation: blink 1.1s ease-in-out infinite; }
  .dots .d.green { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .dots .d.grey  { background: var(--grey); }
  @media (prefers-reduced-motion: reduce) { .dots .d.amber { animation: none; } }

  /* Testo di stato */
  .copy { text-align: center; max-width: 240px; }
  .copy .label {
    font-size: clamp(0.95rem, 4vw, 1.18rem);
    font-weight: 650;
    letter-spacing: 0.01em;
  }
  .copy .sub {
    margin-top: 5px;
    font-size: clamp(0.72rem, 3vw, 0.82rem);
    opacity: 0.55;
    line-height: 1.45;
  }
</style>
</head>
<body class="state-${aggregate}">
  <div class="title">Claude · Status</div>
  <div class="beacon"></div>
  <div class="dots">${dots}</div>
  <div class="copy">
    <div class="label">${label}</div>
    <div class="sub">${sub}</div>
  </div>
</body>
</html>`;
}

// ── Webview View Provider (semaforo nella barra laterale) ─────────────────
class SemaforoViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeSemaforo.view';
  private view?: vscode.WebviewView;
  private aggregate: SemaforoState = 'offline';
  private sessions: SemaforoState[] = [];

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = getSemaforoHtml(this.aggregate, this.sessions);
  }

  update(aggregate: SemaforoState, sessions: SemaforoState[]): void {
    this.aggregate = aggregate;
    this.sessions = sessions;
    if (this.view) {
      this.view.webview.html = getSemaforoHtml(aggregate, sessions);
    }
  }
}

// ── Notifica nativa del sistema operativo (cross-platform) ────────────────
// Mostra un toast a livello di SO, così è visibile anche quando VSCode non è
// la finestra attiva. Fire-and-forget: eventuali errori vengono ignorati.
function notifyOS(title: string, message: string, sound: boolean): void {
  // Rimuovi apici/backtick per evitare rotture di escaping nei comandi shell.
  const t = title.replace(/['"`]/g, ' ').trim();
  const m = message.replace(/['"`]/g, ' ').trim();
  try {
    if (process.platform === 'win32') {
      // Toast WinRT via PowerShell, senza moduli esterni. AppId = PowerShell
      // (id noto e registrato) così il toast viene mostrato in modo affidabile.
      // Aggiungo un nodo <audio> per controllare il suono (default o silenzioso).
      const audio = sound
        ? "$a.SetAttribute('src','ms-winsoundevent:Notification.Default');"
        : "$a.SetAttribute('silent','true');";
      const ps = [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;",
        "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);",
        "$x = $t.GetElementsByTagName('text');",
        `$x.Item(0).AppendChild($t.CreateTextNode('${t}')) | Out-Null;`,
        `$x.Item(1).AppendChild($t.CreateTextNode('${m}')) | Out-Null;`,
        "$a = $t.CreateElement('audio');",
        audio,
        "$t.DocumentElement.AppendChild($a) | Out-Null;",
        "$toast = [Windows.UI.Notifications.ToastNotification]::new($t);",
        "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast);",
      ].join(' ');
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], () => { /* ignora */ });
    } else if (process.platform === 'darwin') {
      // osascript riproduce un suono di sistema con "sound name".
      const snd = sound ? ' sound name "Ping"' : '';
      execFile('osascript', ['-e', `display notification "${m}" with title "${t}"${snd}`], () => { /* ignora */ });
    } else {
      // Linux (richiede libnotify / notify-send, presente sulla maggior parte dei desktop)
      execFile('notify-send', ['-a', 'Claude Status', t, m], () => { /* ignora */ });
      if (sound) {
        // Suono best-effort: prova canberra, poi paplay, infine bell del terminale.
        const play = "canberra-gtk-play -i message-new-instant 2>/dev/null || " +
          "paplay /usr/share/sounds/freedesktop/stereo/message.oga 2>/dev/null || printf '\\a'";
        execFile('sh', ['-c', play], () => { /* ignora */ });
      }
    }
  } catch { /* niente notifica disponibile */ }
}

const NOTIFY_TEXT: Record<SemaforoState, string> = {
  working: 'Claude is working…',
  waiting: 'Claude needs you — waiting for your input',
  idle: 'Claude is ready — you can type a new prompt',
  offline: 'Claude Code is not active',
};

// ── Auto-provisioning degli hook di Claude Code ───────────────────────────
// Utile soprattutto su nuove macchine e ambienti remoti: installando il .vsix
// (lato workspace), l'estensione mette da sola l'hook in ~/.claude/hooks/ e può
// configurare ~/.claude/settings.json. Così non serve copiare nulla a mano.
const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'Stop', 'Notification', 'SubagentStop',
];
const HOOK_FILE = path.join(os.homedir(), '.claude', 'hooks', 'claude-state-hook.js');
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

function hookCommand(ev: string): string {
  return `node -e "require(require('os').homedir()+'/.claude/hooks/claude-state-hook.js')" ${ev}`;
}

// Copia l'hook impacchettato in ~/.claude/hooks/. Con force=false non
// sovrascrive un file già presente (rispetta eventuali personalizzazioni).
function installHookFile(extensionPath: string, force: boolean): boolean {
  try {
    if (!force && fs.existsSync(HOOK_FILE)) { return false; }
    fs.mkdirSync(path.dirname(HOOK_FILE), { recursive: true });
    fs.copyFileSync(path.join(extensionPath, 'claude-state-hook.js'), HOOK_FILE);
    return true;
  } catch { return false; }
}

// Sono già configurati i nostri hook in settings.json?
function settingsConfigured(): boolean {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return HOOK_EVENTS.some(ev => JSON.stringify(j?.hooks?.[ev] ?? '').includes('claude-state-hook.js'));
  } catch { return false; }
}

// Aggiunge i nostri hook a settings.json preservando il resto. SICUREZZA: se il
// file esiste ma non è JSON valido (es. commenti), NON lo tocca.
function mergeSettingsHooks(): { ok: boolean; reason?: string } {
  let raw = '';
  const existed = fs.existsSync(SETTINGS_FILE);
  if (existed) {
    try { raw = fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch { return { ok: false, reason: 'settings.json non leggibile.' }; }
  }
  let j: any = {};
  if (raw.trim()) {
    try { j = JSON.parse(raw); }
    catch { return { ok: false, reason: 'settings.json non è JSON valido (forse contiene commenti): aggiungi gli hook a mano.' }; }
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) { return { ok: false, reason: 'formato di settings.json inatteso.' }; }
  if (!j.hooks || typeof j.hooks !== 'object') { j.hooks = {}; }
  for (const ev of HOOK_EVENTS) {
    const arr: any[] = Array.isArray(j.hooks[ev]) ? j.hooks[ev] : (j.hooks[ev] = []);
    if (!JSON.stringify(arr).includes('claude-state-hook.js')) {
      arr.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand(ev) }] });
    }
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(j, null, 2), 'utf8');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}

// ── Attivazione estensione ─────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  // Status bar item (sempre visibile in basso)
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  // Cliccando la status bar si apre/mette a fuoco la vista laterale.
  statusBar.command = 'claudeSemaforo.view.focus';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Vista webview nella barra laterale (activity bar)
  const viewProvider = new SemaforoViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SemaforoViewProvider.viewType,
      viewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  function updateUI(sessions: Session[], agg: SemaforoState) {
    const info = STATES[agg];
    const n = sessions.length;
    statusBar.text = n > 1 ? `${info.icon} ${info.label} ·${n}` : `${info.icon} ${info.label}`;
    statusBar.backgroundColor = info.color;
    statusBar.tooltip = n > 1 ? `${info.tooltip}  (${n} sessioni attive)` : info.tooltip;
    viewProvider.update(agg, sessions.map(s => s.state));
  }

  // Comando per mettere a fuoco la vista laterale del semaforo
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSemaforo.showPanel', () => {
      vscode.commands.executeCommand('claudeSemaforo.view.focus');
    })
  );

  // Auto-provisioning: su questa macchina (anche remota) assicura l'hook.
  installHookFile(context.extensionPath, false);

  // Comando per installare/riconfigurare hook + settings su questa macchina.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSemaforo.setupHooks', () => {
      installHookFile(context.extensionPath, true);
      const res = mergeSettingsHooks();
      if (res.ok) {
        vscode.window.showInformationMessage('🚦 Hook di Claude Code configurati in ~/.claude. Riavvia le sessioni Claude Code per attivarli.');
      } else {
        vscode.window.showWarningMessage(`🚦 Hook installato, ma non ho toccato settings.json: ${res.reason} Vedi claude-settings-example.json.`);
      }
    })
  );

  // Se gli hook non risultano configurati, proponi la configurazione one-click.
  if (!settingsConfigured()) {
    vscode.window.showInformationMessage(
      '🚦 Claude Status: gli hook di Claude Code non sono configurati su questa macchina. Il semaforo resterà offline finché non lo fai.',
      'Configura ora'
    ).then(choice => {
      if (choice === 'Configura ora') { vscode.commands.executeCommand('claudeSemaforo.setupHooks'); }
    });
  }

  // Titolo notifica: include il nome della cartella così, con più progetti,
  // capisci a colpo d'occhio quale sessione è cambiata.
  const folderName = vscode.workspace.workspaceFolders?.[0]?.name;
  const notifyTitle = folderName ? `Claude Status — ${folderName}` : 'Claude Status';

  // Decide se inviare la notifica di sistema per un cambio di stato, leggendo
  // le impostazioni utente a runtime (i cambi valgono subito, senza reload).
  function maybeNotify(next: SemaforoState) {
    const cfg = vscode.workspace.getConfiguration('claudeSemaforo');
    const when = cfg.get<string>('notifications.when', 'always');
    if (when === 'never') { return; }
    if (when === 'whenUnfocused' && vscode.window.state.focused) { return; }
    const states = cfg.get<string[]>('notifications.states', ['waiting', 'idle']);
    if (!states.includes(next)) { return; }
    const sound = cfg.get<boolean>('notifications.sound', true);
    notifyOS(notifyTitle, NOTIFY_TEXT[next], sound);
  }

  // Firma dello stato mostrato: aggiorniamo il webview SOLO quando cambia,
  // altrimenti il re-render azzererebbe l'animazione ogni secondo.
  let lastSig = '';
  // Stato precedente di ogni sessione, per notificare sui cambi per-sessione.
  const lastSessionStates = new Map<string, SemaforoState>();
  let baseline = true; // primo giro: popola senza notificare

  function refresh() {
    const sessions = readSessions();
    const agg = aggregateState(sessions);

    const sig = agg + '|' + sessions.map(s => `${s.key}=${s.state}`).sort().join(',');
    if (sig !== lastSig) {
      lastSig = sig;
      updateUI(sessions, agg);
    }

    // Notifiche per-sessione (indipendenti dal rendering).
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.key);
      const prev = lastSessionStates.get(s.key);
      lastSessionStates.set(s.key, s.state);
      // Notifica solo su un vero cambio (non alla scoperta della sessione, non
      // sulle transizioni derivate dal timeout anti-blocco).
      if (!baseline && prev !== undefined && prev !== s.state && !s.stale) {
        maybeNotify(s.state);
      }
    }
    for (const k of [...lastSessionStates.keys()]) {
      if (!seen.has(k)) { lastSessionStates.delete(k); }
    }
    baseline = false;
  }

  refresh(); // render iniziale (baseline, nessuna notifica)

  // Polling ogni secondo
  const timer = setInterval(refresh, 1000);

  // Assicura l'esistenza della cartella di stato così il watcher si aggancia
  // subito (senza attendere che l'hook la crei alla prima scrittura).
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignora */ }

  // Watch file system per risposta immediata: ricorsivo su STATE_DIR così
  // cattura le sottocartelle per-progetto e i file per-sessione.
  const watchers: fs.FSWatcher[] = [];
  try { watchers.push(fs.watch(STATE_DIR, { recursive: true }, () => refresh())); } catch { /* fallback: polling */ }
  // Senza workspace usiamo il file legacy nella tmpdir.
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
    try {
      watchers.push(fs.watch(os.tmpdir(), (_e: string, f: string | null) => { if (f === 'claude-code-state.json') { refresh(); } }));
    } catch { /* fallback: polling */ }
  }

  context.subscriptions.push({
    dispose: () => {
      clearInterval(timer);
      watchers.forEach(w => w.close());
    }
  });

  vscode.window.showInformationMessage('🚦 Claude Status is active! Open it from the sidebar icon (or click the status bar).');
}

export function deactivate() { }
