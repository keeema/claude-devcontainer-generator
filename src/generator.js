import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ejs from 'ejs';
import { loadStack, loadServices } from './stack-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates', 'base');

/**
 * Odvodí název projektu z repo URL.
 * git@github.com:zakaznik/mujprojekt.git → mujprojekt
 * https://github.com/zakaznik/mujprojekt.git → mujprojekt
 */
export function nameFromRepo(repoUrl) {
  const basename = repoUrl.split('/').pop().replace(/\.git$/, '');
  if (!basename) {
    throw new Error(`Cannot derive project name from repo URL: ${repoUrl}`);
  }
  return basename;
}

/**
 * Extrahuje pojmenované volumes ze služeb (ne bind-mount cesty).
 * Např. "pgdata:/var/lib/postgresql/data" → { pgdata: true }
 */
export function extractServiceVolumes(services) {
  const volumes = {};

  for (const svc of Object.values(services)) {
    if (!svc.volumes) continue;
    for (const vol of svc.volumes) {
      const source = vol.split(':')[0];
      // Pojmenovaný volume nemá / na začátku ani . na začátku
      if (!source.startsWith('/') && !source.startsWith('.')) {
        volumes[source] = true;
      }
    }
  }

  return volumes;
}

function renderTemplate(templateName, context) {
  const templatePath = join(TEMPLATES_DIR, templateName);
  const template = readFileSync(templatePath, 'utf-8');
  return ejs.render(template, context, { filename: templatePath });
}

/**
 * Generuje kompletní devcontainer repo do output adresáře.
 */
export function generate(options) {
  const { name, repo, branch = 'main', stack: stackName = 'nodejs', services: selectedServices = [], fullInternet = false, includeCompose = false, localClaude = false, sshPort = 2222, output } = options;

  const stack = loadStack(stackName);
  const services = loadServices(selectedServices);
  const serviceVolumes = extractServiceVolumes(services);

  const context = { name, repo, branch, stack, services, serviceVolumes, fullInternet, includeCompose, localClaude, sshPort };

  const devcontainerDir = join(output, '.devcontainer');
  mkdirSync(devcontainerDir, { recursive: true });

  if (localClaude) {
    mkdirSync(join(output, '.project-claude'), { recursive: true });
  }

  // Render všech šablon
  const files = [
    { template: 'project.yml.ejs', output: join(output, 'project.yml') },
    { template: 'init.sh.ejs', output: join(devcontainerDir, 'init.sh'), executable: true },
    ...(!fullInternet ? [{ template: 'init-firewall.sh.ejs', output: join(devcontainerDir, 'init-firewall.sh'), executable: true }] : []),
    { template: 'Dockerfile.ejs', output: join(devcontainerDir, 'Dockerfile') },
    { template: 'docker-compose.yml.ejs', output: join(devcontainerDir, 'docker-compose.yml') },
    { template: 'devcontainer.json.ejs', output: join(devcontainerDir, 'devcontainer.json') },
  ];

  for (const file of files) {
    const content = renderTemplate(file.template, context);
    writeFileSync(file.output, content);
    if (file.executable) {
      chmodSync(file.output, 0o755);
    }
  }
}

/**
 * Vypíše instrukce po vygenerování.
 */
export function printInstructions(name, output, { localClaude = false, sshPort = 2222 } = {}) {
  let claudeInfo = '';
  if (localClaude) {
    claudeInfo = `
6. Projektové Claude nastavení (.claude/CLAUDE.md) jsou v .project-claude/
   složce tohoto devcontainer repa — commitujte je do gitu.
   .claude/ je automaticky přidán do git exclude zákaznického repa.
`;
  }

  const jetbrainsStep = localClaude ? '7' : '6';

  console.log(`
=== Devcontainer vygenerován: ${output} ===

1. Vytvořte sdílený Docker volume (jednou za stroj):
   docker volume create claude-shared

2. Otevřete devcontainer ve VS Code:
   cd ${output}
   code .
   → "Reopen in Container"

3. Připojení ke Claude Code:
   tmux attach -t claude

4. Odpojení (Claude dál pracuje):
   Ctrl+B, pak D

5. Nastavení git credentials (při prvním použití):
   echo "https://<github-user>:<PAT>@github.com" > ~/.git-credentials
   (nebo nechte git se zeptat při prvním push/pull — uloží automaticky)
${claudeInfo}
${jetbrainsStep}. JetBrains IDE (PyCharm, IntelliJ, ...) — přes Gateway:
   - Kontejner exposuje SSH na portu ${sshPort} (mapovaný z kontejneru :22)
   - PyCharm Gateway → SSH na <hostname>:${sshPort}, user: node, bez hesla
   - Backend běží uvnitř kontejneru, otevřete /workspace
   - Interpreter (Python/Node) je přímo v kontejneru, žádná další konfigurace
`);
}
