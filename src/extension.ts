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

// Se la finestra ha una cartella di workspace, legge SOLO i file per-progetto
// corrispondenti: così ogni finestra mostra lo stato della propria sessione, e
// un progetto senza file risulta ⚪ offline (NON lo stato di un altro progetto).
// Il file legacy condiviso è usato solo quando non c'è alcun workspace aperto.
function getStateFilePaths(): string[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 0) {
    return folders.map(f => path.join(STATE_DIR, keyForPath(f.uri.fsPath) + '.json'));
  }
  return [path.join(os.tmpdir(), 'claude-code-state.json')]; // nessun workspace: fallback legacy
}

// ── Lettura stato dal file ─────────────────────────────────────────────────
interface RawState { status: SemaforoState; event: string; ageMs: number; }

function readRawState(): RawState {
  for (const filePath of getStateFilePaths()) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8').trim();

      // Prova JSON prima
      try {
        const json = JSON.parse(content);
        const s = (json.status ?? json.state ?? '').toLowerCase();
        let status: SemaforoState | null = null;
        if (s.includes('think') || s.includes('work') || s.includes('run') || s === 'busy') { status = 'working'; }
        else if (s.includes('wait') || s.includes('confirm') || s.includes('input')) { status = 'waiting'; }
        else if (s === 'idle' || s === 'ready' || s === 'done') { status = 'idle'; }
        if (status) {
          const ts = Date.parse(json.timestamp ?? '');
          const ageMs = isNaN(ts) ? 0 : Math.max(0, Date.now() - ts);
          return { status, event: String(json.event ?? ''), ageMs };
        }
      } catch {
        // Non è JSON — trattalo come stringa semplice
        const s = content.toLowerCase();
        if (s === 'working' || s === 'busy' || s === 'running') { return { status: 'working', event: '', ageMs: 0 }; }
        if (s === 'waiting' || s === 'confirm') { return { status: 'waiting', event: '', ageMs: 0 }; }
        if (s === 'idle' || s === 'ready') { return { status: 'idle', event: '', ageMs: 0 }; }
      }
    } catch {
      // file non leggibile, prova il prossimo
    }
  }
  return { status: 'offline', event: '', ageMs: 0 };
}

// Risolve lo stato da mostrare. Claude Code non emette alcun hook quando
// interrompi un'azione (Esc): il file resta su "working" e il semaforo
// resterebbe rosso per sempre. Come rete di sicurezza, se "working" non si
// aggiorna da troppo tempo E non c'è un tool in esecuzione (PreToolUse), lo
// consideriamo terminato → idle. Un tool lungo (build) resta quindi rosso.
// Ritorna anche `stale` per non generare notifiche su questa transizione.
function resolveState(): { state: SemaforoState; stale: boolean } {
  const raw = readRawState();
  if (raw.status !== 'working') { return { state: raw.status, stale: false }; }
  const timeoutSec = vscode.workspace.getConfiguration('claudeSemaforo')
    .get<number>('staleWorkingTimeoutSeconds', 120);
  if (timeoutSec > 0 && raw.event !== 'PreToolUse' && raw.ageMs > timeoutSec * 1000) {
    return { state: 'idle', stale: true };
  }
  return { state: 'working', stale: false };
}

// ── HTML del semaforo (usato dalla vista laterale) ────────────────────────
function getSemaforoHtml(state: SemaforoState): string {
  const S: Record<SemaforoState, { pos: 'red' | 'amber' | 'green' | 'none'; color: string; msg: string; sub: string }> = {
    working: { pos: 'red', color: '#ff453a', msg: 'Claude is working', sub: 'Processing — please wait' },
    waiting: { pos: 'amber', color: '#ff9f0a', msg: 'Claude needs you', sub: 'Waiting for your input' },
    idle: { pos: 'green', color: '#30d158', msg: 'Ready', sub: 'You can type a new prompt' },
    offline: { pos: 'none', color: '#8e8e93', msg: 'Claude Code is offline', sub: 'No active session here' },
  };
  const s = S[state];
  const act = (p: string) => (s.pos === p ? ' active' : '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Status</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --red: #ff453a; --amber: #ff9f0a; --green: #30d158;
    --glow: ${s.color};
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

  /* Traccia: indica quale dei 3 stati è attivo (identità 'semaforo'). */
  .track { display: flex; gap: 11px; align-items: center; }
  .track .d {
    width: 9px; height: 9px; border-radius: 50%;
    transition: background 0.4s ease, box-shadow 0.4s ease;
  }
  .track .d.red   { background: color-mix(in srgb, var(--red)   30%, transparent); }
  .track .d.amber { background: color-mix(in srgb, var(--amber) 30%, transparent); }
  .track .d.green { background: color-mix(in srgb, var(--green) 30%, transparent); }
  .track .d.active.red   { background: var(--red);   box-shadow: 0 0 9px var(--red); }
  .track .d.active.amber { background: var(--amber); box-shadow: 0 0 9px var(--amber); }
  .track .d.active.green { background: var(--green); box-shadow: 0 0 9px var(--green); }

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
<body class="state-${state}">
  <div class="title">Claude · Status</div>
  <div class="beacon"></div>
  <div class="track">
    <span class="d red${act('red')}"></span>
    <span class="d amber${act('amber')}"></span>
    <span class="d green${act('green')}"></span>
  </div>
  <div class="copy">
    <div class="label">${s.msg}</div>
    <div class="sub">${s.sub}</div>
  </div>
</body>
</html>`;
}

// ── Webview View Provider (semaforo nella barra laterale) ─────────────────
class SemaforoViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeSemaforo.view';
  private view?: vscode.WebviewView;
  private currentState: SemaforoState = 'offline';

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = getSemaforoHtml(this.currentState);
  }

  update(state: SemaforoState): void {
    this.currentState = state;
    if (this.view) {
      this.view.webview.html = getSemaforoHtml(state);
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

  function updateUI(state: SemaforoState) {
    const info = STATES[state];
    statusBar.text = `${info.icon} ${info.label}`;
    statusBar.backgroundColor = info.color;
    statusBar.tooltip = info.tooltip;
    viewProvider.update(state);
  }

  // Comando per mettere a fuoco la vista laterale del semaforo
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSemaforo.showPanel', () => {
      vscode.commands.executeCommand('claudeSemaforo.view.focus');
    })
  );

  // Titolo notifica: include il nome della cartella così, con più progetti,
  // capisci a colpo d'occhio quale sessione è cambiata.
  const folderName = vscode.workspace.workspaceFolders?.[0]?.name;
  const notifyTitle = folderName ? `Claude Status — ${folderName}` : 'Claude Status';

  // Stato iniziale come baseline (nessuna notifica all'avvio).
  let lastState: SemaforoState = resolveState().state;
  updateUI(lastState);

  // Decide se inviare la notifica di sistema per il nuovo stato, leggendo le
  // impostazioni utente a runtime (i cambi valgono subito, senza reload).
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

  // Applica un nuovo stato: aggiorna la UI e valuta la notifica.
  // `allowNotify` è false per le transizioni derivate dal timeout di
  // "working stantio" (interruzione), che non devono suonare/notificare.
  function applyState(next: SemaforoState, allowNotify: boolean) {
    if (next === lastState) { return; }
    lastState = next;
    updateUI(next);
    if (allowNotify) { maybeNotify(next); }
  }

  function refresh() {
    const { state, stale } = resolveState();
    applyState(state, !stale);
  }

  // Polling ogni secondo
  const timer = setInterval(refresh, 1000);

  // Assicura l'esistenza della cartella di stato così il watcher si aggancia
  // subito (senza attendere che l'hook la crei alla prima scrittura).
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignora */ }

  // Watch file system per risposta immediata
  const watchers: fs.FSWatcher[] = [];
  for (const fp of getStateFilePaths()) {
    try {
      const dir = path.dirname(fp);
      if (fs.existsSync(dir)) {
        const w = fs.watch(dir, refresh);
        watchers.push(w);
      }
    } catch { /* directory non accessibile */ }
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
