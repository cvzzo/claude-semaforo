# 🚦 Claude Status — Estensione VSCode

Semaforo visivo per monitorare lo stato di Claude Code in tempo reale.

| Luce       | Significato                              |
| ---------- | ---------------------------------------- |
| 🔴 Rosso   | Claude sta lavorando (usa tool, elabora) |
| 🟠 Arancio | Claude aspetta la tua conferma o input   |
| 🟢 Verde   | Puoi scrivere un nuovo prompt            |
| ⚪ Grigio  | Claude Code non è attivo                 |

---

## Installazione in 3 passi

### 1. Installa l'estensione VSCode

```bash
cd claude-semaforo
npm install
npm run compile

# Installa con vsce (o apri la cartella in VSCode e premi F5 per debug)
npm install -g @vscode/vsce
vsce package
code --install-extension claude-semaforo-1.2.1.vsix
```

### 2. Configura gli hook di Claude Code

**Linux / macOS**

```bash
mkdir -p ~/.claude/hooks
cp claude-state-hook.js ~/.claude/hooks/
# ⚠️  Se hai già un ~/.claude/settings.json, AGGIUNGI solo la sezione "hooks"
cp claude-settings-example.json ~/.claude/settings.json
```

**Windows (PowerShell)**

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\hooks"
Copy-Item claude-state-hook.js "$HOME\.claude\hooks\"
# ⚠️  Se hai già un settings.json, AGGIUNGI solo la sezione "hooks"
Copy-Item claude-settings-example.json "$HOME\.claude\settings.json"
```

Se hai già un `settings.json`, aggiungi manualmente la sezione `"hooks"` dal file `claude-settings-example.json`.

> **Perché il comando hook è `node -e "require(require('os').homedir()+...)"` e non `node ~/.claude/hooks/...`?**
> Gli hook di Claude Code girano nella shell di sistema: `sh` su Linux/macOS (che espande `~`), ma `cmd.exe` su Windows (che **non** espande `~` né `$HOME`). Facendo calcolare la home a Node con `os.homedir()`, lo **stesso** comando funziona identico su tutti i sistemi. Il nome dell'evento arriva dal JSON che Claude Code invia su `stdin` (con fallback sull'argomento CLI finale).

### 3. Riapri VSCode

Trovi il semaforo in due punti:

- l'**icona nella barra laterale** (activity bar): cliccala per aprire il pannello grafico del semaforo, che resta agganciato lì come una vista (non come tab dell'editor);
- la **status bar in basso a sinistra**: mostra lo stato in forma compatta; cliccandola metti a fuoco la vista laterale.

---

## Come funziona

```
Claude Code lavora
    → lancia hook (UserPromptSubmit / PreToolUse / PermissionRequest / …)
    → claude-state-hook.js scrive <tmpdir>/claude-semaforo/<hash(cwd)>.json
      (Windows: %TEMP%  ·  Linux: /tmp  ·  macOS: /var/folders/…)
    → l'estensione VSCode legge il file della PROPRIA cartella (workspace)
      ogni secondo (+ file watcher) → aggiorna status bar e vista laterale
```

### Stato per-progetto (più Claude in parallelo)

Ogni sessione scrive un file **separato**, con nome derivato dall'hash del suo
`cwd`. Ogni finestra VSCode calcola lo stesso hash dalla propria cartella di
workspace e legge **solo** il file corrispondente → semafori indipendenti per
progetti diversi. Un progetto senza file risulta ⚪ **offline** (non mostra lo
stato di un altro progetto). All'avvio di una sessione l'evento `SessionStart`
crea subito il file → 🟢 verde.

L'hook scrive anche `<tmpdir>/claude-code-state.json` (legacy condiviso), ma
l'estensione lo usa **solo** quando la finestra non ha alcuna cartella aperta.

> Limite: due sessioni Claude nella **stessa** cartella condividono lo stato
> (stesso `cwd` → stesso file).

### Hook → Stato

| Evento Claude Code  | Condizione               | Stato Semaforo |
| ------------------- | ------------------------ | -------------- |
| `SessionStart`      | —                        | 🟢 Verde       |
| `UserPromptSubmit`  | —                        | 🔴 Rosso       |
| `PreToolUse`        | tool = `AskUserQuestion` | 🟠 Arancio     |
| `PreToolUse`        | qualsiasi altro tool     | 🔴 Rosso       |
| `PermissionRequest` | —                        | 🟠 Arancio     |
| `PostToolUse`       | —                        | 🔴 Rosso       |
| `Notification`      | —                        | 🟠 Arancio     |
| `Stop`              | —                        | 🟢 Verde       |
| Nessun file         | —                        | ⚪ Offline     |

> **Quando scatta l'arancio (🟠)?** In tre casi, tutti "Claude aspetta te":
>
> 1. **`PermissionRequest`** — appare il dialog "Allow this command?": Claude attende che tu **approvi o neghi** un tool. L'evento scatta esattamente quando compare il dialog. Sequenza: `PreToolUse` (🔴) → `PermissionRequest` (🟠) → _approvi_ → `PostToolUse` (🔴).
> 2. **`PreToolUse` con tool `AskUserQuestion`** — Claude sta per farti una domanda a scelta. L'hook legge il `tool_name` dallo stdin JSON e, per i tool in `WAITING_TOOLS`, scrive `waiting`. Appena rispondi, il `PostToolUse` riporta a 🔴.
> 3. **`Notification`** — altre notifiche di attesa (es. input fermo a lungo).
>
> Per trattare altri tool come "attesa", aggiungili al set `WAITING_TOOLS` in `claude-state-hook.js`.

### Notifiche desktop

Quando lo stato cambia **e la finestra VSCode non è a fuoco**, arriva una
**notifica di sistema** (toast) — così te ne accorgi anche mentre lavori su
un'altra applicazione. La notifica scatta solo per gli stati in cui Claude
aspetta te o ha finito:

| Nuovo stato | Notifica                                      |
| ----------- | --------------------------------------------- |
| 🟠 waiting  | "Claude needs you — waiting for your input"   |
| 🟢 idle     | "Claude is ready — you can type a new prompt" |

Se la finestra VSCode **è** a fuoco non arriva nulla (stai già guardando il
semaforo). Il titolo include il nome della cartella, utile con più progetti
aperti. Toast nativo: PowerShell (Windows), `osascript` (macOS),
`notify-send` (Linux).

**Impostazioni** (`File → Preferences → Settings`, cerca "Claude Status"):

| Impostazione                                     | Default              | Cosa fa                                                                                 |
| ------------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------- |
| `claudeSemaforo.notifications.enabled`           | `true`               | Attiva/disattiva le notifiche desktop.                                                  |
| `claudeSemaforo.notifications.sound`             | `true`               | Riproduce un suono con la notifica.                                                     |
| `claudeSemaforo.notifications.onlyWhenUnfocused` | `true`               | Notifica solo se la finestra VSCode non è a fuoco. Metti `false` per notificare sempre. |
| `claudeSemaforo.notifications.states`            | `["waiting","idle"]` | Quali stati notificare (`working`, `waiting`, `idle`).                                  |

Le impostazioni si applicano **subito**, senza ricaricare VSCode.

**Animazione del beacon:** 🟠 waiting **lampeggia** (Claude ti aspetta → attira l'attenzione), 🔴 working fa un "respiro" gentile, 🟢 idle e ⚪ offline restano fissi. Rispetta `prefers-reduced-motion`.

---

## Personalizzazione

Puoi modificare la mappatura eventi→stato in `claude-state-hook.js`:

```js
if (event === "PreToolUse") {
  status = "working"; // cambia qui
}
```

E i colori/messaggi in `src/extension.ts` nella costante `STATES`.
