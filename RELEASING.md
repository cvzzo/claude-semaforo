# Release su GitHub

La distribuzione avviene tramite **GitHub Releases** (si allegano il `.vsix` e lo
zip completo). Non si pubblica su store.

## Passi per una nuova versione
1. Aggiorna la versione in `package.json` e aggiungi una voce in `CHANGELOG.md`.
   Se hai cambiato la logica dell'hook, incrementa il marcatore
   `claude-status-hook-version` in `claude-state-hook.js`.
2. Compila e impacchetta:
   ```bash
   npm run compile
   npx @vscode/vsce package        # -> claude-semaforo-<versione>.vsix
   ```
3. Commit + tag:
   ```bash
   git add -A && git commit -m "vX.Y.Z: ..."
   git tag -a vX.Y.Z -m "Claude Status vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
4. Crea la release con gli allegati (serve `gh auth login` una volta, oppure
   `GH_TOKEN`):
   ```bash
   gh release create vX.Y.Z \
     --title "Claude Status vX.Y.Z" \
     --notes-file dist/RELEASE_NOTES.md \
     claude-semaforo-<versione>.vsix \
     claude-semaforo-<versione>-complete.zip
   ```

## Installazione lato utente
Si scarica il `.vsix` dalla release e si installa con
`code --install-extension claude-semaforo-<versione>.vsix`, oppure si usa lo zip
completo (estensione + hook + guida) seguendo `INSTALL.txt`.
