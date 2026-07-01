"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const STATES = {
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
function keyForPath(p) {
    let norm = path.resolve(p).replace(/\\/g, '/');
    if (process.platform === 'win32') {
        norm = norm.toLowerCase();
    }
    return crypto.createHash('md5').update(norm).digest('hex').slice(0, 16);
}
// Se la finestra ha una cartella di workspace, legge SOLO i file per-progetto
// corrispondenti: così ogni finestra mostra lo stato della propria sessione, e
// un progetto senza file risulta ⚪ offline (NON lo stato di un altro progetto).
// Il file legacy condiviso è usato solo quando non c'è alcun workspace aperto.
function getStateFilePaths() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 0) {
        return folders.map(f => path.join(STATE_DIR, keyForPath(f.uri.fsPath) + '.json'));
    }
    return [path.join(os.tmpdir(), 'claude-code-state.json')]; // nessun workspace: fallback legacy
}
// ── Lettura stato dal file ─────────────────────────────────────────────────
function readStateFromFile() {
    for (const filePath of getStateFilePaths()) {
        try {
            if (!fs.existsSync(filePath))
                continue;
            const content = fs.readFileSync(filePath, 'utf8').trim();
            // Prova JSON prima
            try {
                const json = JSON.parse(content);
                const s = (json.status ?? json.state ?? '').toLowerCase();
                if (s.includes('think') || s.includes('work') || s.includes('run') || s === 'busy')
                    return 'working';
                if (s.includes('wait') || s.includes('confirm') || s.includes('input'))
                    return 'waiting';
                if (s === 'idle' || s === 'ready' || s === 'done')
                    return 'idle';
            }
            catch {
                // Non è JSON — trattalo come stringa semplice
                const s = content.toLowerCase();
                if (s === 'working' || s === 'busy' || s === 'running')
                    return 'working';
                if (s === 'waiting' || s === 'confirm')
                    return 'waiting';
                if (s === 'idle' || s === 'ready')
                    return 'idle';
            }
        }
        catch {
            // file non leggibile, prova il prossimo
        }
    }
    return 'offline';
}
// ── HTML del semaforo (usato dalla vista laterale) ────────────────────────
function getSemaforoHtml(state) {
    const S = {
        working: { pos: 'red', color: '#ff453a', msg: 'Claude is working', sub: 'Processing — please wait' },
        waiting: { pos: 'amber', color: '#ff9f0a', msg: 'Claude needs you', sub: 'Waiting for your input' },
        idle: { pos: 'green', color: '#30d158', msg: 'Ready', sub: 'You can type a new prompt' },
        offline: { pos: 'none', color: '#8e8e93', msg: 'Claude Code is offline', sub: 'No active session here' },
    };
    const s = S[state];
    const act = (p) => (s.pos === p ? ' active' : '');
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
class SemaforoViewProvider {
    constructor() {
        this.currentState = 'offline';
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: false };
        webviewView.webview.html = getSemaforoHtml(this.currentState);
    }
    update(state) {
        this.currentState = state;
        if (this.view) {
            this.view.webview.html = getSemaforoHtml(state);
        }
    }
}
SemaforoViewProvider.viewType = 'claudeSemaforo.view';
// ── Notifica nativa del sistema operativo (cross-platform) ────────────────
// Mostra un toast a livello di SO, così è visibile anche quando VSCode non è
// la finestra attiva. Fire-and-forget: eventuali errori vengono ignorati.
function notifyOS(title, message, sound) {
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
            (0, child_process_1.execFile)('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], () => { });
        }
        else if (process.platform === 'darwin') {
            // osascript riproduce un suono di sistema con "sound name".
            const snd = sound ? ' sound name "Ping"' : '';
            (0, child_process_1.execFile)('osascript', ['-e', `display notification "${m}" with title "${t}"${snd}`], () => { });
        }
        else {
            // Linux (richiede libnotify / notify-send, presente sulla maggior parte dei desktop)
            (0, child_process_1.execFile)('notify-send', ['-a', 'Claude Status', t, m], () => { });
            if (sound) {
                // Suono best-effort: prova canberra, poi paplay, infine bell del terminale.
                const play = "canberra-gtk-play -i message-new-instant 2>/dev/null || " +
                    "paplay /usr/share/sounds/freedesktop/stereo/message.oga 2>/dev/null || printf '\\a'";
                (0, child_process_1.execFile)('sh', ['-c', play], () => { });
            }
        }
    }
    catch { /* niente notifica disponibile */ }
}
const NOTIFY_TEXT = {
    working: 'Claude is working…',
    waiting: 'Claude needs you — waiting for your input',
    idle: 'Claude is ready — you can type a new prompt',
    offline: 'Claude Code is not active',
};
// ── Attivazione estensione ─────────────────────────────────────────────────
function activate(context) {
    // Status bar item (sempre visibile in basso)
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    // Cliccando la status bar si apre/mette a fuoco la vista laterale.
    statusBar.command = 'claudeSemaforo.view.focus';
    statusBar.show();
    context.subscriptions.push(statusBar);
    // Vista webview nella barra laterale (activity bar)
    const viewProvider = new SemaforoViewProvider();
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(SemaforoViewProvider.viewType, viewProvider, { webviewOptions: { retainContextWhenHidden: true } }));
    function updateUI(state) {
        const info = STATES[state];
        statusBar.text = `${info.icon} ${info.label}`;
        statusBar.backgroundColor = info.color;
        statusBar.tooltip = info.tooltip;
        viewProvider.update(state);
    }
    // Comando per mettere a fuoco la vista laterale del semaforo
    context.subscriptions.push(vscode.commands.registerCommand('claudeSemaforo.showPanel', () => {
        vscode.commands.executeCommand('claudeSemaforo.view.focus');
    }));
    // Titolo notifica: include il nome della cartella così, con più progetti,
    // capisci a colpo d'occhio quale sessione è cambiata.
    const folderName = vscode.workspace.workspaceFolders?.[0]?.name;
    const notifyTitle = folderName ? `Claude Status — ${folderName}` : 'Claude Status';
    // Stato iniziale come baseline (nessuna notifica all'avvio).
    let lastState = readStateFromFile();
    updateUI(lastState);
    // Decide se inviare la notifica di sistema per il nuovo stato, leggendo le
    // impostazioni utente a runtime (i cambi valgono subito, senza reload).
    function maybeNotify(next) {
        const cfg = vscode.workspace.getConfiguration('claudeSemaforo');
        if (!cfg.get('notifications.enabled', true)) {
            return;
        }
        if (cfg.get('notifications.onlyWhenUnfocused', true) && vscode.window.state.focused) {
            return;
        }
        const states = cfg.get('notifications.states', ['waiting', 'idle']);
        if (!states.includes(next)) {
            return;
        }
        const sound = cfg.get('notifications.sound', true);
        notifyOS(notifyTitle, NOTIFY_TEXT[next], sound);
    }
    // Applica un nuovo stato: aggiorna la UI e valuta la notifica.
    function applyState(next) {
        if (next === lastState) {
            return;
        }
        lastState = next;
        updateUI(next);
        maybeNotify(next);
    }
    // Polling ogni secondo
    const timer = setInterval(() => applyState(readStateFromFile()), 1000);
    // Assicura l'esistenza della cartella di stato così il watcher si aggancia
    // subito (senza attendere che l'hook la crei alla prima scrittura).
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    catch { /* ignora */ }
    // Watch file system per risposta immediata
    const watchers = [];
    for (const fp of getStateFilePaths()) {
        try {
            const dir = path.dirname(fp);
            if (fs.existsSync(dir)) {
                const w = fs.watch(dir, () => applyState(readStateFromFile()));
                watchers.push(w);
            }
        }
        catch { /* directory non accessibile */ }
    }
    context.subscriptions.push({
        dispose: () => {
            clearInterval(timer);
            watchers.forEach(w => w.close());
        }
    });
    vscode.window.showInformationMessage('🚦 Claude Status is active! Open it from the sidebar icon (or click the status bar).');
}
function deactivate() { }
