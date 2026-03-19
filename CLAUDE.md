# DevContainer Generator

## Co to je

CLI nástroj v Node.js, který generuje kompletní devcontainer repozitáře pro zákaznické projekty. Výstupem je samostatné repo `<nazev>-devcontainer`, které se pushne na GitHub.

## Proč oddělený devcontainer repo

- Vývojář chce vlastní devcontainer s Claude Code, ale nechce přidávat soubory do zákaznického repa
- Zákaznické repo zůstane čisté — žádný `.devcontainer/`, žádný `.claude/`
- Každý zákaznický projekt může mít jiný stack
- Vlastní tooling, poznámky a CLAUDE.md nesdílíme se zákazníkem
- Při ukončení spolupráce odevzdáme čisté repo

## Architektura generovaného devcontaineru

### Struktura výstupu

```
<nazev>-devcontainer/
  ├── .devcontainer/
  │   ├── devcontainer.json
  │   ├── docker-compose.yml
  │   ├── Dockerfile
  │   ├── init-firewall.sh       ← iptables pravidla, whitelist domén
  │   └── init.sh                ← naklonuje zákaznické repo pokud neexistuje
  └── project.yml                ← konfigurace projektu (repo URL, branch, cesty)
```

Po vygenerování CLI vypíše instrukce: jak spustit kontejner, jak vytvořit `.claude/CLAUDE.md` v projektu, jak přidat `.claude/` do `.gitignore` zákaznického repa.

### Požadavek: plně funkční Claude Code sandbox

Generovaný devcontainer MUSÍ být plně funkční prostředí pro Claude Code v bezpečném sandbox režimu, inspirované referenčním Anthropic devcontainerem (https://github.com/anthropics/claude-code/tree/main/.devcontainer). To znamená:

#### 1. Dockerfile — bezpečný kontejner s Claude Code

Založený na base image podle zvoleného stacku (Node.js, Python, .NET). Obsahuje:

- **Vývojářské nástroje:** git, zsh (s oh-my-zsh a pluginy), tmux (s rozumným výchozím .tmux.conf — historie, myš, status bar), ripgrep, fzf, curl, jq
- **Node.js:** automaticky doinstalovaný pro non-Node stacky (Python, .NET) — potřeba pro Claude Code
- **Claude Code:** nainstalovaný globálně přes npm (`npm install -g @anthropic-ai/claude-code`)
- **Firewall script** (bez `--full-internet`): zkopírovaný do `/usr/local/bin/init-firewall.sh`
- **Uživatel `node`:** kontejner běží jako neprivilegovaný uživatel, ne root (vytvořen pokud neexistuje)
- **Sudo bez omezení:** `node ALL=(root) NOPASSWD: ALL` — devcontainer je izolované prostředí, granulární omezování sudo je zbytečné
- **Git credential isolation:** `credential.helper=store` s persistentním souborem, VS Code credential forwarding je zablokovaný přes settings a remoteEnv

#### 2. init-firewall.sh — síťová izolace (volitelná)

Generuje se jen bez `--full-internet` flagu. Iptables firewall s default-deny politikou. Povolené jsou vždy:

- **Claude API:** `api.anthropic.com`, `statsig.anthropic.com`, `sentry.io`
- **Package managers:** `registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `api.nuget.org`
- **Git:** `github.com`, `gitlab.com`
- **DNS a SSH:** vždy povoleny
- **Vše ostatní:** zablokováno

Stack definice může přidat další domény přes `firewall_domains`.

Firewall se spouští přes `postStartCommand` a kontejner čeká na jeho dokončení (`waitFor: postStartCommand`).

Kontejner potřebuje capability `NET_ADMIN` a `NET_RAW` pro iptables.

S `--full-internet`: firewall se přeskočí, žádné `NET_ADMIN`/`NET_RAW`, žádný `postStartCommand`.

#### 3. devcontainer.json — kompletní konfigurace

```json
{
  "dockerComposeFile": "docker-compose.yml",
  "service": "app",
  "workspaceFolder": "/workspace",
  "remoteUser": "node",

  "customizations": {
    "vscode": {
      "extensions": ["anthropic.claude-code"],
      "settings": {
        "claude-code.enableAutoSkipPermissions": true,
        "git.terminalAuthentication": false,
        "dev.containers.gitCredentialHelperConfigLocation": "none"
      }
    }
  },

  "containerEnv": {
    "NODE_OPTIONS": "--max-old-space-size=4096",
    "CLAUDE_CONFIG_DIR": "/home/node/.claude",
    "POWERLEVEL9K_DISABLE_GITSTATUS": "true"
  },

  "remoteEnv": {
    "VSCODE_GIT_ASKPASS_MAIN": "",
    "VSCODE_GIT_ASKPASS_NODE": "",
    "VSCODE_GIT_ASKPASS_EXTRA_ARGS": "",
    "VSCODE_GIT_IPC_HANDLE": "",
    "GIT_ASKPASS": ""
  },

  "initializeCommand": ".devcontainer/init.sh",
  "postStartCommand": "sudo /usr/local/bin/init-firewall.sh",
  "waitFor": "postStartCommand"
}
```

Extensions se rozšiřují podle stacku (Python, .NET apod.).

#### 4. docker-compose.yml — služby a mounty

```yaml
name: <nazev> # prefix pro všechny kontejnery (mujprojekt-app-1, mujprojekt-db-1...)

services:
  app:
    build:
      context: .devcontainer
      dockerfile: Dockerfile
    volumes:
      - ../mujprojekt:/workspace:cached # zdrojový kód (sourozenec vedle)
      - claude-credentials:/home/node/.claude # globální Claude (sdílený)
      - <nazev>-claude-project:/workspace/.claude # projektový Claude config
      - <nazev>-commandhistory:/commandhistory # bash/zsh historie (per-projekt)
    command: >
      bash -c "sudo npm i -g @anthropic-ai/claude-code && tmux new-session -d -s claude 'claude --dangerously-skip-permissions' && sleep infinity"
    # Pozn.: Při prvním spuštění (bez OAuth credentials ve volume) Claude
    # čeká na přihlášení. Vývojář se připojí přes "tmux attach -t claude",
    # dokončí OAuth login, a od té chvíle auto-start funguje.
    cap_add:
      - NET_ADMIN
      - NET_RAW
    environment:
      - CLAUDE_CONFIG_DIR=/home/node/.claude

volumes:
  claude-credentials:
    external: true # sdílený across projekty, vytvořen jednou
  <nazev>-claude-project: # per-projekt, vytvořen automaticky
  <nazev>-commandhistory: # per-projekt, historie příkazů přežije rebuild
```

Pokud zákaznické repo má vlastní docker-compose (DB, LDAP, Redis...), použije se `--include-compose`:

```yaml
include:
  - path: ../mujprojekt/docker-compose.yml
```

### Tři vrstvy persistentních dat

1. **`claude-credentials`** — globální Docker volume, mountovaný na `/home/node/.claude`. OAuth tokeny, globální nastavení. Sdílený across všemi projekty na stroji. Označen `external: true`, uživatel ho vytvoří jednou (`docker volume create claude-credentials`).

2. **`<nazev>-claude-project`** — per-projekt Docker volume, mountovaný na `/workspace/.claude`. Obsahuje `CLAUDE.md` (Claude Code ho najde jako `.claude/CLAUDE.md` — oficiálně podporované umístění), projektová nastavení a settings. Persistentní přes rebuildy kontejneru. Zákaznické repo žádný `.claude/` adresář nemá — volume ho překryje, takže není potřeba `.gitignore`.

3. **Zdrojový kód** — bind mount zákaznického repa z disku do `/workspace`.

4. **`<nazev>-commandhistory`** — per-projekt bash/zsh historie, přežije rebuild kontejneru.

### --dangerously-skip-permissions

Díky firewallu a izolaci kontejneru je bezpečné spustit Claude Code v tomto režimu. Claude může volně:

- Číst/zapisovat soubory v `/workspace`
- Spouštět příkazy v kontejneru
- Instalovat packages

Ale NEMŮŽE:

- Přistoupit k hostitelským souborům mimo mount
- Komunikovat s internetem mimo whitelist
- Eskalovat oprávnění

### tmux — vzdálené ovládání Claude Code

Klíčový požadavek: Claude Code se automaticky spustí v tmux session při startu kontejneru. Vývojář se jen připojí.

V `docker-compose.yml` je `command` nastavený tak, že kontejner při startu:

1. Vytvoří tmux session `claude`
2. V ní spustí `claude --dangerously-skip-permissions`
3. `sleep infinity` drží kontejner naživu

To umožňuje:

- Odpojit se od kontejneru a Claude dál pracuje
- Připojit se z jiného stroje (SSH z telefonu, jiný počítač) a vidět co Claude dělá
- Mít víc terminálů — jeden s Claude v tmux, ostatní volné pro git, testy atd.

Generovaný devcontainer musí zajistit:

1. **tmux je nainstalovaný** v Dockerfile (už je v seznamu nástrojů)
2. **tmux config** — rozumné výchozí nastavení (historie, myš, status bar)
3. **Auto-start** — `command` v docker-compose spustí Claude v tmux automaticky
4. **Instrukce pro vývojáře** — CLI po vygenerování vypíše:

```
Připojení ke Claude Code:
  tmux attach -t claude

Odpojení (Claude dál pracuje):
  Ctrl+B, pak D
```

Typický workflow:

- Ráno: VS Code → "Reopen in Container" → terminál → `tmux attach -t claude` → Claude už běží
- Přes den: sledujete/ovládáte Claude, zadáváte úkoly
- Zavřete VS Code → Claude pracuje dál v tmux
- Z telefonu: SSH na VM → `docker exec -it <kontejner> bash` → `tmux attach -t claude`
- Večer: VS Code znovu → terminál → `tmux attach -t claude` → Claude má hotovo

### init.sh — automatický clone

`initializeCommand` spustí `init.sh` na hostu před startem kontejneru. Skript přečte `project.yml` a naklonuje repo jako sourozenecký adresář vedle devcontainer repa (pokud ještě neexistuje).

```yaml
# project.yml
repo: git@github.com:neco/mujprojekt.git
branch: main
```

Konvence adresářové struktury:

```
~/projects/
  ├── mujprojekt-devcontainer/   ← devcontainer repo (tady běží init.sh)
  └── mujprojekt/                ← zákaznické repo (naklonováno vedle)
```

`init.sh` odvodí cílovou cestu jako `../<nazev>` (název projektu bez `-devcontainer` suffixu, nebo explicitně z `project.yml`). Volume mount v docker-compose odpovídá: `../mujprojekt:/workspace:cached`.

## Stacky a služby

Stacky (SDK/runtime) a služby jsou oddělené vrstvy, volitelně kombinovatelné.

### Stacky (`src/templates/stacks/`)

YAML soubory definující base image, nástroje a VS Code extensions:

```yaml
# src/templates/stacks/nodejs.yml
name: nodejs
display_name: "Node.js (LTS)"
base_image: node:22
tools: [git, zsh, tmux, ripgrep, fzf, curl, jq]
vscode_extensions:
  - dbaeumer.vscode-eslint
firewall_domains: []
```

Dostupné stacky: `nodejs` (node:22), `python` (python:3.12), `dotnet` (dotnet/sdk:9.0).

### Služby (`src/templates/services/`)

Jednotlivě volitelné přes `--services`:

```yaml
# src/templates/services/postgres.yml
name: postgres
display_name: "PostgreSQL"
image: postgres:16
env:
  POSTGRES_USER: dev
  POSTGRES_PASSWORD: dev
  POSTGRES_DB: dev
ports:
  - "5432:5432"
volumes:
  - pgdata:/var/lib/postgresql/data
```

Dostupné služby: `postgres`, `mongo`, `redis`, `azurite`.

## Technologie

- **Node.js** — runtime
- **Commander** — parsování CLI argumentů
- **EJS** — šablonování souborů (devcontainer.json, Dockerfile, docker-compose.yml, init.sh, init-firewall.sh)
- **js-yaml** — čtení stack definic a project.yml
- **Žádné další závislosti** — držet minimální

## Struktura projektu

```
devcontainer-generator/
  ├── src/
  │   ├── cli.js                  ← vstupní bod, Commander definice
  │   ├── generator.js            ← hlavní logika generování
  │   ├── stack-loader.js         ← načítání stacků a služeb z YAML
  │   └── templates/
  │       ├── base/               ← EJS šablony výstupních souborů
  │       │   ├── devcontainer.json.ejs
  │       │   ├── docker-compose.yml.ejs
  │       │   ├── Dockerfile.ejs
  │       │   ├── init-firewall.sh.ejs
  │       │   ├── init.sh.ejs
  │       │   └── project.yml.ejs
  │       ├── stacks/             ← SDK/runtime definice
  │       │   ├── nodejs.yml
  │       │   ├── python.yml
  │       │   └── dotnet.yml
  │       └── services/           ← definice služeb
  │           ├── postgres.yml
  │           ├── mongo.yml
  │           ├── redis.yml
  │           └── azurite.yml
  ├── test/
  │   ├── stack-loader.test.js
  │   └── generator.test.js
  ├── package.json
  ├── CLAUDE.md                   ← tento soubor
  └── README.md
```

## Použití

```bash
node src/cli.js \
  --repo git@github.com:zakaznik-b/projekt.git \
  --branch main \
  --stack nodejs \
  --services postgres,redis \
  --output ~/projects/projekt-devcontainer
```

### Volitelné flagy

- `--full-internet` — přeskočí firewall, plný přístup k internetu
- `--include-compose` — zahrne zákaznický `docker-compose.yml` přes compose `include`

## Konvence kódu

- ES modules (`"type": "module"` v package.json)
- Žádný TypeScript — zbytečná komplexita pro tento nástroj
- Funkce pojmenované anglicky, komentáře mohou být česky
- Testy pomocí Node.js test runner (`node --test`)
- Každá šablona musí generovat validní výstup — testovat přes dry-run

## Devcontainer pro tento projekt

Tento projekt sám používá devcontainer (meta!). Jednoduchý setup:

```json
{
  "image": "node:22",
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/anthropics/devcontainer-features/claude-code:1": {}
  },
  "mounts": ["source=claude-credentials,target=/home/node/.claude,type=volume"],
  "containerEnv": {
    "CLAUDE_CONFIG_DIR": "/home/node/.claude"
  },
  "postCreateCommand": "npm install"
}
```

## TODO

- [x] Základní CLI s Commander
- [x] Načítání stack definic z YAML
- [x] EJS šablony pro všechny výstupní soubory
- [x] Generátor — spojí stack + vstupy + šablony → výstupní složka
- [x] init-firewall.sh šablona s dynamickým whitelistem
- [x] Dockerfile šablona s nástroji a Claude Code
- [x] Podpora pro include zákaznického docker-compose (`--include-compose`)
- [x] Volitelný firewall (`--full-internet`)
- [x] Oddělené stacky (nodejs, python, dotnet) a služby (postgres, mongo, redis, azurite)
- [x] Výpis instrukcí po vygenerování
- [x] Testy (37 testů)
- [x] Dokumentace (README.md)
- [ ] Interaktivní režim (inquirer nebo prompts)
- [ ] Validace vstupů (repo URL format, existence stacku)
