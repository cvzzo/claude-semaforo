# Pubblicazione

`publisher` in `package.json` è **`cvzzo`**: deve combaciare con il namespace
Open VSX e con il publisher del Marketplace.

## Build del pacchetto
```bash
npm run compile
npx @vscode/vsce package        # crea claude-semaforo-<versione>.vsix
```

## Open VSX (per Coder / code-server / VSCodium)
1. Registrati su https://open-vsx.org (login Eclipse) e crea un **Access Token**
   (Profilo → Access Tokens).
2. Una tantum, crea il namespace:
   ```bash
   npx ovsx create-namespace cvzzo -p <TOKEN>
   ```
3. Pubblica:
   ```bash
   npx ovsx publish claude-semaforo-<versione>.vsix -p <TOKEN>
   ```
Dopo, sui remoti la installi/aggiorni dal pannello Estensioni (cerca "Claude Status").

## VS Code Marketplace (per VS Code desktop)
1. Crea il publisher **cvzzo** su https://marketplace.visualstudio.com/manage
   e un **PAT** su Azure DevOps (scope: Marketplace → Manage).
2. Pubblica:
   ```bash
   npx @vscode/vsce publish -p <PAT>
   # oppure pubblica un .vsix già creato:
   npx @vscode/vsce publish --packagePath claude-semaforo-<versione>.vsix -p <PAT>
   ```

## Note
- Bump della **versione** in `package.json` ad ogni release, e aggiorna `CHANGELOG.md`.
- Se cambi la logica dell'hook, incrementa anche il marcatore
  `claude-status-hook-version` in `claude-state-hook.js` (così l'estensione
  propone l'aggiornamento dell'hook agli utenti).
- L'installazione da store **auto-aggiorna** su tutte le macchine: niente più
  `.vsix` da copiare a mano.
