# Changelog

## 1.16.0
- **Tempo nello stato** live nella status bar (es. "in attesa da 45s", "lavora da 2m").
- **Snooze notifiche**: comando "Snooze notifications" per silenziare desktop + Telegram per 15m/30m/1h/2h (icona 🔕 in status bar).

## 1.15.0
- Pronta per la pubblicazione: icona, `publisher`, `repository`, `LICENSE` (MIT), keywords, questo changelog.

## 1.14.0
- Nome custom per sessione: env `CLAUDE_STATUS_NAME` al lancio o comando "Rename a session". Compare in tooltip e notifiche.

## 1.13.0
- Notifiche Telegram ritardate (anti-rumore): 🟠 dopo 10s, 🟢 dopo 30s, solo se lo stato resta invariato.

## 1.12.0
- Config Telegram ibrida: impostazioni VSCode con priorità, fallback su `~/.claude/claude-status.json`.

## 1.11.1
- Setup Telegram guidato (comando), senza editare il JSON; rileva il chat id.

## 1.11.0
- Notifiche Telegram (Bot API).

## 1.10.2
- Sessioni chiuse rilevate meglio (backstop ridotto, cleanup attivo).

## 1.10.1
- Auto-aggiornamento dell'hook per versione.

## 1.10.0
- Auto-provisioning dell'hook + supporto ambienti remoti (`extensionKind: workspace`).

## 1.9.x
- Supporto multi-sessione: beacon aggregato + pallini numerati per sessione.

## 1.8.x
- Fix race che lasciava il semaforo rosso; rete di sicurezza per le interruzioni (Esc).

## 1.0–1.7
- Semaforo in status bar e vista laterale; hook cross-platform; stato per-progetto;
  redesign "beacon"; notifiche desktop con suono; arancione lampeggiante.
