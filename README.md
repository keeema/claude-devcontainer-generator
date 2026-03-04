# DevContainer Generator

CLI nástroj pro generování oddělených devcontainer repozitářů s předinstalovaným Claude Code.

## Proč?

Definice vývojového prostředí nepatří do projektového repa:
- Dev prostředí (`.devcontainer/`, `.claude/`) nechceš verzovat v projektu
- Každý vývojář nebo tým může mít jiný setup
- Projektové repo zůstane čisté — žádné IDE/tooling soubory
- Snadná reprodukovatelnost prostředí na jiném stroji

Řešení: vygeneruj si **oddělené devcontainer repo**, které žije vedle projektového repa. Projekt zůstane čistý — žádné `.devcontainer/`, žádné `.claude/`.

## Předpoklady

- Node.js 20+
- Docker Desktop (nebo Docker Engine)
- VS Code s rozšířením [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

## Rychlý start

### 1. Nainstaluj závislosti

```bash
npm install
```

### 2. Vygeneruj devcontainer

```bash
node src/cli.js \
  --repo git@github.com:firma/mujprojekt.git \
  --stack nodejs \
  --services postgres \
  --output ~/projects/mujprojekt-devcontainer
```

### 3. Otevři ve VS Code

```bash
cd ~/projects/mujprojekt-devcontainer
code .
```

VS Code detekuje `.devcontainer/` a nabídne **"Reopen in Container"** (nebo přes Command Palette → `Dev Containers: Reopen in Container`).

Při prvním spuštění se automaticky:
1. Naklonuje projektové repo vedle devcontaineru
2. Vytvoří sdílený Docker volume `claude-credentials` (pokud neexistuje)
3. Postaví Docker image s vývojářskými nástroji a Claude Code
4. Spustí kontejner a Claude Code nastartuje v tmux session

### 4. Připoj se ke Claude Code

V kontejneru běží Claude Code automaticky v tmux session. Otevři terminál ve VS Code a připoj se:

```bash
tmux attach -t claude
```

Při prvním spuštění bude Claude čekat na OAuth přihlášení. Po přihlášení se credentials uloží do sdíleného volume a příště se Claude spustí automaticky.

> **Tip:** Devcontainer obsahuje i VS Code extension `anthropic.claude-code`, takže Claude Code můžeš použít i přímo ve VS Code.

### 5. Odpojení

```bash
# Ctrl+B, pak D — odpojí se od tmux, Claude dál pracuje
```

Můžeš zavřít VS Code a Claude pracuje dál. Při dalším otevření se jen znovu připojíš přes `tmux attach -t claude`.

## Jak to funguje

```
~/projects/
  ├── mujprojekt-devcontainer/     ← vygenerované devcontainer repo
  │   ├── .devcontainer/
  │   │   ├── devcontainer.json    ← konfigurace VS Code, extensions, env
  │   │   ├── docker-compose.yml   ← app + služby, volumes, networking
  │   │   ├── Dockerfile           ← base image, nástroje, Claude Code
  │   │   ├── init-firewall.sh     ← iptables whitelist (pokud není --full-internet)
  │   │   └── init.sh              ← klonuje projektové repo, vytvoří volumes
  │   └── project.yml              ← metadata projektu (repo URL, branch)
  └── mujprojekt/                  ← projektové repo (naklonované automaticky)
```

### Tři vrstvy dat

| Volume | Mount | Účel | Sdílení |
|--------|-------|------|---------|
| `claude-credentials` | `/home/node/.claude` | OAuth tokeny, globální nastavení | Across všechny projekty |
| `<nazev>-claude-project` | `/workspace/.claude` | CLAUDE.md, projektové nastavení | Per projekt |
| `<nazev>-commandhistory` | `/commandhistory` | Bash/zsh historie | Per projekt |
| Bind mount | `/workspace` | Zdrojový kód projektu | — |

Všechny volumes přežijí rebuild kontejneru. `claude-credentials` se vytvoří automaticky při prvním spuštění.

## CLI parametry

| Parametr | Povinný | Default | Popis |
|----------|---------|---------|-------|
| `--repo` | ano | — | Git URL projektového repa |
| `--output` | ano | — | Cílový adresář pro vygenerovaný devcontainer |
| `--name` | ne | z repo URL | Název projektu (odvozen automaticky z URL) |
| `--branch` | ne | `main` | Git branch k naklonování |
| `--stack` | ne | `nodejs` | SDK/runtime (`nodejs`, `python`, `dotnet`) |
| `--services` | ne | — | Služby oddělené čárkou (`postgres`, `redis`, `mongo`, `azurite`) |
| `--full-internet` | ne | `false` | Vypne firewall — plný přístup k internetu |
| `--include-compose` | ne | `false` | Zahrne projektový `docker-compose.yml` přes Docker Compose `include` |

## Stacky (SDK/runtime)

| Stack | Base image | Popis |
|-------|-----------|-------|
| `nodejs` | `node:22` | Node.js LTS |
| `python` | `python:3.12` | Python 3.12 |
| `dotnet` | `mcr.microsoft.com/dotnet/sdk:9.0` | .NET 9 |

Každý stack automaticky nainstaluje Claude Code (vyžaduje Node.js — u non-Node stacků se doinstaluje automaticky).

## Služby

Libovolná kombinace přes `--services postgres,redis,mongo,azurite`:

| Služba | Image | Port |
|--------|-------|------|
| `postgres` | `postgres:16` | 5432 |
| `mongo` | `mongo:7` | 27017 |
| `redis` | `redis:7` | 6379 |
| `azurite` | Azure Storage Emulator | 10000-10002 |

## Příklady

### Node.js projekt s PostgreSQL a Redis

```bash
node src/cli.js \
  --repo git@github.com:firma/eshop.git \
  --stack nodejs \
  --services postgres,redis \
  --output ~/projects/eshop-devcontainer
```

### .NET projekt s plným internetem a projektovým docker-compose

```bash
node src/cli.js \
  --repo git@github.com:firma/erp.git \
  --stack dotnet \
  --full-internet \
  --include-compose \
  --output ~/projects/erp-devcontainer
```

### Python projekt bez služeb

```bash
node src/cli.js \
  --repo git@github.com:firma/ml-pipeline.git \
  --stack python \
  --output ~/projects/ml-pipeline-devcontainer
```

## Firewall

Ve výchozím stavu kontejner povoluje jen:
- **Claude API** — `api.anthropic.com`, `statsig.anthropic.com`, `sentry.io`
- **Git** — `github.com`, `gitlab.com`
- **Package managers** — npm, yarn, pip, nuget
- **DNS a SSH**

Vše ostatní je blokováno přes iptables (kontejner má `NET_ADMIN` capability). Pro plný přístup k internetu použij `--full-internet` — firewall se vůbec nevytvoří.

## Práce s Claude Code

### Tmux session

Claude Code se automaticky spustí v tmux session při startu kontejneru:

```bash
# Připojení
tmux attach -t claude

# Odpojení (Claude dál pracuje)
Ctrl+B, pak D

# Z jiného stroje přes SSH
docker exec -it <kontejner> bash
tmux attach -t claude
```

### Typický workflow

1. **Ráno:** VS Code → "Reopen in Container" → terminál → `tmux attach -t claude`
2. **Přes den:** zadáváš úkoly, sleduješ výstup
3. **Odcházíš:** `Ctrl+B, D` — Claude pracuje dál, můžeš zavřít VS Code
4. **Z telefonu:** SSH na stroj → `docker exec -it <kontejner> bash` → `tmux attach -t claude`
5. **Další den:** VS Code znovu → `tmux attach -t claude` → Claude má hotovo

### Projektové instrukce (CLAUDE.md)

Volume `<nazev>-claude-project` se mountuje na `/workspace/.claude`. Vytvoř v něm `CLAUDE.md` s projektovými instrukcemi:

```bash
# Uvnitř kontejneru
echo "# Projektové instrukce" > /workspace/.claude/CLAUDE.md
```

Soubor přežije rebuild kontejneru a projektové repo zůstane čisté (volume překryje adresář).

## Vývoj

```bash
npm install
npm test
```
