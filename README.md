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

### Auto-configurazione (e ambienti remoti: SSH / Coder / container)

All'avvio l'estensione **installa da sola l'hook** in `~/.claude/hooks/` (se
manca) e, se `settings.json` non contiene gli hook, mostra un avviso con il
pulsante **"Configura ora"**. Puoi anche lanciare manualmente il comando
**"Claude Status: Set up Claude Code hooks (this machine)"** dalla palette
(`Ctrl/Cmd+Shift+P`): copia l'hook e unisce gli hook a `settings.json`
preservando il resto (se il file non è JSON valido, non lo tocca).

> **Remoti:** su Coder/SSH/container il tuo `~/.claude` è quello **della
> macchina remota**, non del PC locale. L'estensione è marcata `workspace`,
> quindi gira lato remoto: **installala nel remoto** ("Install in SSH/Coder: …")
> e usa "Configura ora". Poi riavvia le sessioni Claude Code sul remoto.

---

## Come funziona

```
Claude Code lavora
    → lancia hook (UserPromptSubmit / PreToolUse / PermissionRequest / …)
    → claude-state-hook.js scrive <tmpdir>/claude-semaforo/<hash(cwd)>/<session_id>.json
      (Windows: %TEMP%  ·  Linux: /tmp  ·  macOS: /var/folders/…)
    → l'estensione VSCode legge TUTTE le sessioni della PROPRIA cartella
      ogni secondo (+ file watcher) → aggrega e aggiorna status bar e vista
```

### Più sessioni Claude in parallelo

Ogni sessione Claude scrive un **file separato** in
`<tmpdir>/claude-semaforo/<hash(cwd)>/<session_id>.json` (il `session_id`
arriva dagli hook). Questo vale **anche per più sessioni nella stessa
cartella/finestra**: restano indipendenti. All'avvio (`SessionStart`) il file
viene creato (🟢); alla chiusura (`SessionEnd`) viene rimosso.

L'estensione legge **tutte** le sessioni della propria cartella di workspace e
mostra:
- un **beacon aggregato** = lo stato più **urgente** (🟠 se almeno una aspetta
  te → 🔴 se almeno una lavora → 🟢 se tutte pronte);
- una fila di **pallini**, uno per sessione, con il colore del suo stato (i
  pallini 🟠 lampeggiano);
- un riepilogo, es. *"3 sessions · 1 waiting · 2 working"*, e il conteggio nella
  status bar (`·3`).

Le **notifiche** scattano per-sessione (quando una singola sessione cambia
stato). Una sessione che si aggiorna da troppo tempo (crash senza `SessionEnd`)
viene scartata dopo `sessionTimeoutMinutes`.

L'hook scrive anche `<tmpdir>/claude-code-state.json` (legacy condiviso), usato
dall'estensione **solo** quando la finestra non ha alcuna cartella aperta.

### Hook → Stato

| Evento Claude Code  | Condizione               | Stato Semaforo |
| ------------------- | ------------------------ | -------------- |
| `SessionStart`      | —                        | 🟢 Verde       |
| `SessionEnd`        | —                        | (sessione rimossa) |
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

Quando lo stato cambia arriva una **notifica di sistema** (toast). Di default
scatta **sempre**, ma puoi limitarla a quando la finestra VSCode non è in primo
piano, o disattivarla del tutto (impostazione `notifications.when`, vedi sotto).
La notifica scatta solo per gli stati in cui Claude aspetta te o ha finito:

| Nuovo stato | Notifica                                      |
| ----------- | --------------------------------------------- |
| 🟠 waiting  | "Claude needs you — waiting for your input"   |
| 🟢 idle     | "Claude is ready — you can type a new prompt" |

Il titolo include il nome della cartella, utile con più progetti aperti. Toast
nativo: PowerShell (Windows), `osascript` (macOS), `notify-send` (Linux).

**Impostazioni** (`File → Preferences → Settings`, cerca "Claude Status"):

| Impostazione                                     | Default              | Cosa fa                                                                                 |
| ------------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------- |
| `claudeSemaforo.notifications.when`              | `always`             | Quando notificare: `always` (sempre, anche a finestra in primo piano), `whenUnfocused` (solo se non in primo piano), `never` (mai). |
| `claudeSemaforo.notifications.sound`             | `true`               | Riproduce un suono con la notifica.                                                     |
| `claudeSemaforo.notifications.states`            | `["waiting","idle"]` | Quali stati notificare (`working`, `waiting`, `idle`).                                  |
| `claudeSemaforo.staleWorkingTimeoutSeconds`      | `120`                | Rete di sicurezza per le interruzioni (vedi sotto). `0` = disattivato.                  |
| `claudeSemaforo.sessionTimeoutMinutes`           | `60`                 | Scarta una sessione ferma da troppo (crash senza `SessionEnd`). `0` = mai.              |

Le impostazioni si applicano **subito**, senza ricaricare VSCode.

### Interruzioni (Esc)

Claude Code **non** emette alcun hook quando interrompi un'azione con `Esc`
(non esiste un evento di annullamento). Senza rete, il file resterebbe su
`working` e il semaforo **rimarrebbe rosso per sempre**. Per questo, se lo stato
resta `working` per più di `staleWorkingTimeoutSeconds` secondi **senza
aggiornamenti e senza un tool in esecuzione** (`PreToolUse`), l'estensione lo
considera terminato e passa a 🟢. Un tool lungo (es. una build) resta invece 🔴,
perché sta davvero lavorando. Alza il valore se vedi falsi 🟢 durante attese
lunghe, abbassalo per sbloccare prima dopo un'interruzione, o metti `0` per
disattivare del tutto.

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
