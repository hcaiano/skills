# Checks

Pick the sections for the advisory's ecosystem and attack vector, and within
them the lines for this OS (`uname -s`: `Linux` or `Darwin`). They are starting
points: adapt them to the advisory.

- Prefer each tool's own "list installed" command over guessing install paths.
  Use a filesystem `find` only for locations no lister or manifest covers.
- Make path searches path-aware (`-path "*/<pkg>"`) so scoped names such as
  `@vendor/pkg` are found.
- Search the current working tree and any path the user named as well as `~`:
  the audit may run from a checkout outside `$HOME`.
- A lister that fails without elevated rights (e.g. `docker images` outside
  the `docker` group) is recorded as "not checked", never retried with `sudo`.
- For an ecosystem not listed here (Go modules, Ruby gems, …), apply the same
  pattern: the tool's lister, a manifest and lockfile grep, running processes.

## Node / npm (supply-chain advisories)

```bash
which npm pnpm yarn
npm ls -g --depth=0 2>/dev/null | grep -i "<pkg>"
pnpm ls -g --depth=0 2>/dev/null | grep -i "<pkg>"
# Global roots outside $HOME, which `find ~` cannot see. Any depth: direct,
# scoped @vendor/pkg, or transitive under */node_modules/.
for root in "$(npm root -g 2>/dev/null)" "$(pnpm root -g 2>/dev/null)" \
            /usr/local/lib/node_modules /usr/lib/node_modules \
            /opt/homebrew/lib/node_modules; do
  [ -d "$root" ] && find "$root" -type d -path "*/<pkg>" 2>/dev/null
done
# Local copies, including version-manager globals (mise, nvm, fnm, volta keep
# one root per installed Node version under ~).
find ~ . -maxdepth 10 -type d -path "*/node_modules/<pkg>" 2>/dev/null \
  | grep -v -E "(Library/Caches|\.Trash|\.local/share/Trash)"
# Manifests and lockfiles: direct and transitive.
find ~/code ~/Desktop ~/Downloads . -maxdepth 8 -type f \
  \( -name "package.json" -o -name "package-lock.json" \
     -o -name "pnpm-lock.yaml" -o -name "yarn.lock" \) -print0 2>/dev/null \
  | xargs -0 grep -l "<pkg>" 2>/dev/null
```

## Python

```bash
which python3 pip pipx uv
pip list 2>/dev/null | grep -i "<pkg>"
pipx list 2>/dev/null | grep -i "<pkg>"      # pipx apps have their own venvs
uv tool list 2>/dev/null | grep -i "<pkg>"   # uv tools have their own venvs
find ~/code . -maxdepth 6 -type f \( -name "requirements*.txt" \
  -o -name "pyproject.toml" -o -name "poetry.lock" -o -name "uv.lock" \) \
  -print0 2>/dev/null | xargs -0 grep -l "<pkg>" 2>/dev/null
```

## Rust

```bash
cargo install --list 2>/dev/null | grep -i "<pkg>"
find ~/code . -maxdepth 6 -type f -name "Cargo.lock" -print0 2>/dev/null \
  | xargs -0 grep -l "name = \"<pkg>\"" 2>/dev/null
```

## System packages and binaries

```bash
which <binary>; <binary> --version 2>/dev/null
# Linux
dpkg -l 2>/dev/null | grep -i "<pkg>"
flatpak list 2>/dev/null | grep -i "<pkg>"
snap list 2>/dev/null | grep -i "<pkg>"
# macOS
brew list --versions <formula> 2>/dev/null
```

## Containers

```bash
docker images 2>/dev/null | grep -i "<image>"
docker ps --format '{{.Image}} {{.Ports}}' 2>/dev/null | grep -i "<image>"
```

## Running processes and listeners (network / RCE)

```bash
pgrep -lf "<binary>"
# Linux: without sudo, process names show only for your own sockets
ss -ltnp 2>/dev/null | grep ":<port>"
# macOS
lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | grep "<port>"
```

## Persistence and autostart

```bash
crontab -l 2>/dev/null | grep -i "<vendor>"
# Linux
systemctl --user list-unit-files 2>/dev/null | grep -i "<vendor>"
systemctl list-unit-files 2>/dev/null | grep -i "<vendor>"
ls /etc/systemd/system ~/.config/systemd/user ~/.config/autostart \
   /etc/xdg/autostart /etc/cron.d 2>/dev/null | grep -i "<vendor>"
# macOS
ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons \
   2>/dev/null | grep -i "<vendor>"
```

## Env vars that change exposure (e.g. a listening address)

```bash
grep -r "<VAR>" ~/.bashrc ~/.zshrc ~/.profile ~/.zprofile ~/.config \
  2>/dev/null
# Linux
systemctl --user show-environment 2>/dev/null | grep "<VAR>"
# macOS
launchctl getenv <VAR>
```

## Editor and browser extensions (IDE-targeted advisories)

```bash
ls ~/.vscode/extensions ~/.cursor/extensions 2>/dev/null | grep -i "<ext>"
```
