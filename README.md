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
2. Vytvoří sdílený Docker volume `claude-shared` (pokud neexistuje)
3. Vytvoří per-devcontainer volume `<nazev>-git-credentials` (pokud neexistuje)
4. Postaví Docker image s vývojářskými nástroji a Claude Code
5. Spustí kontejner a Claude Code nastartuje v tmux session

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
  │   │   ├── init.sh              ← klonuje projektové repo, vytvoří volumes
  │   │   ├── init                 ← Mac/Linux wrapper nad init.sh
  │   │   └── init.cmd             ← Windows wrapper (spustí init.sh přes Git Bash)
  │   ├── .workspace-claude/       ← s --local-claude: kontext do /workspace/.claude
  │   ├── .project-claude/         ← s --local-claude: kontext do /workspace/<nazev>/.claude
  │   ├── .gitattributes           ← konce řádků (LF pro skripty, CRLF pro .cmd)
  │   ├── README.md                ← project-specific návod pro vývojáře
  │   └── project.yml              ← metadata projektu (repo URL, branch)
  └── mujprojekt/                  ← projektové repo (naklonované automaticky)
```

### Vrstvy dat

| Volume | Mount | Účel | Sdílení |
|--------|-------|------|---------|
| `claude-shared` | `/home/node/.claude` | OAuth tokeny, globální nastavení | Across všechny devcontainery |
| `<nazev>-git-credentials` | `/home/node/.gitcreds` | Git PAT (`~/.git-credentials`) | Per devcontainer |
| `<nazev>-commandhistory` | `/commandhistory` | Bash/zsh historie | Per projekt |
| Bind mount | `/workspace/<nazev>` | Zdrojový kód projektu | — |
| Bind mount (`--local-claude`) | `/workspace/.claude` + `/workspace/<nazev>/.claude` | CLAUDE.md a projektová nastavení, verzovaná v devcontainer repu | Per projekt |

Všechny volumes přežijí rebuild kontejneru. `claude-shared` a `<nazev>-git-credentials` se vytvoří automaticky při prvním spuštění (`init.sh`). Oba jsou `external: true`, takže `<nazev>-git-credentials` přežije i `docker compose down -v` — token zadáváš jen jednou za celý život devcontaineru.

## Windows

`initializeCommand` je řetěz `.devcontainer\init.cmd || .devcontainer/init`: na Windows
ho spustí cmd.exe a padne na `init.cmd`, pod `/bin/sh` první token selže a Mac/Linux
propadne na wrapper `init`. Veškerá logika zůstává v `init.sh`.

- **Vyžaduje [Git for Windows](https://gitforwindows.org/)** — `init.cmd` ho hledá
  v `%ProgramFiles%\Git` a `%LocalAppData%\Programs\Git`. Záměrně nepoužívá holý
  `bash.exe` z PATH: v System32 je WSL bash.
- **Konce řádků** řeší vygenerovaný `.gitattributes` (skripty LF, `*.cmd` CRLF).
  Bez toho by CRLF rozbil heredoc v `Dockerfile`, který nastavuje `GH_TOKEN`.
  Do repa, které už bylo commitnuté z Windows s CRLF, je potřeba jednou pustit
  `git add --renormalize .`.
- **Exec bit:** když generuješ na Windows, `chmod` je no-op a `.devcontainer/init`
  se commitne bez práva ke spuštění → na macOS pak `initializeCommand` selže.
  Náprava: `git update-index --chmod=+x .devcontainer/init`.
- Na macOS se v Dev Containers logu vždy nejdřív objeví
  `sh: .devcontainerinit.cmd: command not found` — očekávané, ne chyba.

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
- **DNS a odchozí SSH** (git přes SSH)

Vše ostatní je blokováno přes iptables (kontejner má `NET_ADMIN` capability). Pro plný přístup k internetu použij `--full-internet` — firewall se vůbec nevytvoří.

## Git credentials (PAT)

Devcontainer nikdy nepřebírá git credentials z hostitele (VS Code credential forwarding je vypnutý). Místo toho používáš **fine-grained Personal Access Token**, který se uloží do `~/.git-credentials` a **přežije rebuild kontejneru**.

### Jak token nastavit

Uvnitř kontejneru (terminál ve VS Code nebo `tmux attach -t claude`) jednou spusť:

```bash
echo "https://<github-user>:<fine-grained-PAT>@github.com" > ~/.git-credentials
```

To je vše — `git push`/`pull` i `gh` od teď fungují. `gh` CLI si token načte automaticky přes `GH_TOKEN`, který se při startu shellu parsuje z `~/.git-credentials` (nastaveno v `~/.zshenv`).

### Proč to přežije rebuild

`~/.git-credentials` je symlink do per-devcontainer Docker volume `<nazev>-git-credentials`. Kanonická cesta se nemění, takže workflow ani `GH_TOKEN` parsing nic nepoznají — data jen leží na persistentním externím volume.

Volume je `external: true` — záměrně **není** spravovaný Docker Compose, takže přežije i `docker compose down -v`. Token tedy zadáváš jen jednou za celý život devcontaineru.

Na rozdíl od `claude-shared` (sdílený přes všechny devcontainery jednoho uživatele) je `<nazev>-git-credentials` **per-devcontainer** — každý projekt má vlastní token.

## Práce s Claude Code

### Tmux session

Claude Code se automaticky spustí v tmux session při startu kontejneru:

```bash
# Připojení
tmux attach -t claude

# Odpojení (Claude dál pracuje)
Ctrl+B, pak D

# Mimo VS Code — z hostu (z jiného stroje nejdřív SSH na host)
docker exec -it <kontejner> zsh
tmux attach -t claude
```

Kontejner **nemá vlastní SSH server** a nepublikuje žádný port pro přihlášení — vstupuje se do něj jen přes VS Code (Dev Containers) nebo přes `docker exec` z hostu.

### Typický workflow

1. **Ráno:** VS Code → "Reopen in Container" → terminál → `tmux attach -t claude`
2. **Přes den:** zadáváš úkoly, sleduješ výstup
3. **Odcházíš:** `Ctrl+B, D` — Claude pracuje dál, můžeš zavřít VS Code
4. **Z telefonu:** SSH na hostitelský stroj → `docker exec -it <kontejner> zsh` → `tmux attach -t claude`
5. **Další den:** VS Code znovu → `tmux attach -t claude` → Claude má hotovo

### Projektové instrukce (CLAUDE.md)

S `--local-claude` se generují dva bind-mountované kontexty, oba verzované v devcontainer repu:

| Zdroj v devcontainer repu | Mount v kontejneru | K čemu |
|---|---|---|
| `.workspace-claude/CLAUDE.md` | `/workspace/.claude/CLAUDE.md` | Rozcestník — Claude Code běží s cwd `/workspace`, takže tohle čte první |
| `.project-claude/CLAUDE.md` | `/workspace/<nazev>/.claude/CLAUDE.md` | Projektová pravidla |

Generátor je předvyplní skeletonem; workspace verze odkazuje na projektovou, ať řetěz
`workspace → projekt` drží. Edituj je přes kteroukoli cestu (je to týž soubor)
a **commituj z devcontainer repa** — v projektovém repu je `.claude/`
v `.git/info/exclude`, takže se do zákazníkova repa nedostane.

## Vývoj

```bash
npm install
npm test
```
