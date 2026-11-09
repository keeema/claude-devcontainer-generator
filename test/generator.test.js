import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generate, extractServiceVolumes, nameFromRepo } from '../src/generator.js';

// devcontainer.json je JSONC (povolené komentáře) — odstraň plné řádkové
// komentáře před parsováním.
function parseJsonc(content) {
  return JSON.parse(content.replace(/^\s*\/\/.*$/gm, ''));
}

describe('extractServiceVolumes', () => {
  it('extracts named volumes from services', () => {
    const services = {
      db: { image: 'postgres:16', volumes: ['pgdata:/var/lib/postgresql/data'] },
    };
    const result = extractServiceVolumes(services);
    assert.deepEqual(result, { pgdata: true });
  });

  it('ignores bind mounts', () => {
    const services = {
      app: { image: 'node:22', volumes: ['./src:/app', '/host/path:/container'] },
    };
    const result = extractServiceVolumes(services);
    assert.deepEqual(result, {});
  });

  it('handles services without volumes', () => {
    const services = {
      redis: { image: 'redis:7' },
    };
    const result = extractServiceVolumes(services);
    assert.deepEqual(result, {});
  });
});

describe('generate', () => {
  let outputDir;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'devcontainer-test-'));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  const baseOptions = {
    name: 'testproject',
    repo: 'git@github.com:test/repo.git',
    branch: 'main',
    stack: 'nodejs',
    services: [],
    output: undefined,
  };

  function opts(overrides = {}) {
    return { ...baseOptions, output: outputDir, ...overrides };
  }

  // --- Basic output structure ---

  it('creates all output files in correct structure', () => {
    generate(opts());
    const devcontainerDir = join(outputDir, '.devcontainer');
    assert.ok(existsSync(join(outputDir, 'README.md')));
    assert.ok(existsSync(join(outputDir, 'project.yml')));
    assert.ok(existsSync(join(outputDir, 'testproject.code-workspace')));
    assert.ok(existsSync(join(devcontainerDir, 'init.sh')));
    assert.ok(existsSync(join(devcontainerDir, 'init-firewall.sh')));
    assert.ok(existsSync(join(devcontainerDir, 'Dockerfile')));
    assert.ok(existsSync(join(devcontainerDir, 'docker-compose.yml')));
    assert.ok(existsSync(join(devcontainerDir, 'devcontainer.json')));
  });

  it('project.yml contains repo and branch', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, 'project.yml'), 'utf-8');
    assert.ok(content.includes('git@github.com:test/repo.git'));
    assert.ok(content.includes('branch: main'));
  });

  it('shell scripts have executable permissions', () => {
    generate(opts());
    const devcontainerDir = join(outputDir, '.devcontainer');
    const initMode = statSync(join(devcontainerDir, 'init.sh')).mode;
    assert.ok(initMode & 0o100, 'init.sh should be executable');
    const firewallMode = statSync(join(devcontainerDir, 'init-firewall.sh')).mode;
    assert.ok(firewallMode & 0o100, 'init-firewall.sh should be executable');
  });

  it('init.sh references correct repo URL', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'init.sh'), 'utf-8');
    assert.ok(content.includes('git@github.com:test/repo.git'));
    assert.ok(content.includes('testproject'));
  });

  // --- Stacks ---

  it('nodejs stack uses node:22 base image', () => {
    generate(opts({ stack: 'nodejs' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.startsWith('FROM node:22'));
    assert.ok(!content.includes('nodesource'));
  });

  it('python stack uses python base image and installs Node.js', () => {
    generate(opts({ stack: 'python' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.startsWith('FROM python:3.12'));
    assert.ok(content.includes('nodesource'));
  });

  it('dotnet stack uses dotnet base image and installs Node.js', () => {
    generate(opts({ stack: 'dotnet' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.startsWith('FROM mcr.microsoft.com/dotnet/sdk:'));
    assert.ok(content.includes('nodesource'));
  });

  it('devcontainer.json has base extensions for any stack', () => {
    generate(opts({ stack: 'nodejs' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    const ext = json.customizations.vscode.extensions;
    assert.ok(ext.includes('anthropic.claude-code'));
    assert.ok(ext.includes('dbaeumer.vscode-eslint'));
    assert.ok(ext.includes('esbenp.prettier-vscode'));
    assert.ok(ext.includes('streetsidesoftware.code-spell-checker'));
    assert.ok(ext.includes('donjayamanne.githistory'));
    assert.ok(ext.includes('github.vscode-github-actions'));
    assert.ok(!ext.includes('eamodio.gitlens'), 'gitlens byl odebrán');
    assert.ok(!ext.includes('bierner.markdown-mermaid'), 'markdown-mermaid byl odebrán');
  });

  it('nodejs stack has jest extension', () => {
    generate(opts({ stack: 'nodejs' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.ok(json.customizations.vscode.extensions.includes('orta.vscode-jest'));
  });

  it('python stack has python extension', () => {
    generate(opts({ stack: 'python' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.ok(json.customizations.vscode.extensions.includes('ms-python.python'));
  });

  // --- Services ---

  it('no services when none selected', () => {
    generate(opts({ services: [] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes('postgres:16'));
    assert.ok(!content.includes('redis:7'));
  });

  it('postgres service included when selected', () => {
    generate(opts({ services: ['postgres'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('postgres:16'));
    assert.ok(content.includes('pgdata:'));
  });

  it('redis service included when selected', () => {
    generate(opts({ services: ['redis'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('redis:7'));
  });

  it('mongo service included when selected', () => {
    generate(opts({ services: ['mongo'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('mongo:7'));
    assert.ok(content.includes('mongodata:'));
  });

  it('azurite service included when selected', () => {
    generate(opts({ services: ['azurite'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('azurite'));
    assert.ok(content.includes('azuritedata:'));
  });

  it('multiple services can be combined', () => {
    generate(opts({ services: ['postgres', 'redis', 'azurite'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('postgres:16'));
    assert.ok(content.includes('redis:7'));
    assert.ok(content.includes('azurite'));
  });

  it('docker-compose.yml has correct project-named volumes', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('testproject-commandhistory:'));
    assert.ok(content.includes('claude-shared:'));
    assert.ok(!content.includes('testproject-claude-project:'));
  });

  it('docker-compose.yml uses devcontainer as service name', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('devcontainer:'));
    assert.ok(!content.includes('  app:'));
  });

  it('devcontainer.json references devcontainer service', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.equal(json.service, 'devcontainer');
  });

  // --- Firewall ---

  it('firewall script contains base domains and package managers', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'init-firewall.sh'), 'utf-8');
    assert.ok(content.includes('api.anthropic.com'));
    assert.ok(content.includes('github.com'));
    assert.ok(content.includes('registry.npmjs.org'));
    assert.ok(content.includes('pypi.org'));
    assert.ok(content.includes('api.nuget.org'));
  });

  // --- Full internet mode ---

  it('fullInternet skips firewall script', () => {
    generate(opts({ fullInternet: true }));
    assert.ok(!existsSync(join(outputDir, '.devcontainer', 'init-firewall.sh')));
  });

  it('fullInternet removes NET_ADMIN from docker-compose', () => {
    generate(opts({ fullInternet: true }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes('NET_ADMIN'));
  });

  it('fullInternet removes postStartCommand from devcontainer.json', () => {
    generate(opts({ fullInternet: true }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.equal(json.postStartCommand, undefined);
    assert.equal(json.waitFor, undefined);
  });

  it('fullInternet removes iptables from Dockerfile', () => {
    generate(opts({ fullInternet: true }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(!content.includes('iptables'));
    assert.ok(!content.includes('init-firewall.sh'));
  });

  // --- Local Claude ---

  it('no .claude mount without localClaude', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes('/workspace/.claude'));
    assert.ok(!content.includes('.project-claude'));
  });

  it('localClaude creates .project-claude directory', () => {
    generate(opts({ localClaude: true }));
    assert.ok(existsSync(join(outputDir, '.project-claude')));
  });

  it('localClaude adds bind-mount for .claude', () => {
    generate(opts({ localClaude: true }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('.project-claude:/workspace/testproject/.claude:cached'));
  });

  it('localClaude adds .claude to git exclude in init.sh', () => {
    generate(opts({ localClaude: true }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'init.sh'), 'utf-8');
    assert.ok(content.includes('.claude/'));
    assert.ok(content.includes('exclude'));
  });

  it('no git exclude without localClaude', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'init.sh'), 'utf-8');
    assert.ok(!content.includes('exclude'));
  });

  // --- Claude Code installation ---

  it('Dockerfile uses native installer for Claude Code, not npm install -g', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('https://claude.ai/install.sh'));
    assert.ok(!content.includes('npm install -g @anthropic-ai/claude-code'));
  });

  it('Dockerfile puts /home/node/.local/bin on PATH', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('/home/node/.local/bin'));
  });

  it('docker-compose.yml command does not reinstall Claude Code at startup', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes('npm i -g @anthropic-ai/claude-code'));
  });

  // --- Žádný SSH server v kontejneru ---
  // Regrese: kontejner dřív pouštěl sshd s prázdným heslem uživatele node a
  // publikoval ho na host — šlo se přihlásit ze sítě bez hesla i bez klíče.

  it('Dockerfile does not install or configure an SSH server', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(!content.includes('openssh-server'));
    assert.ok(!content.includes('sshd'));
    assert.ok(!content.includes('PermitEmptyPasswords'));
    assert.ok(!content.includes('passwd -d'));
  });

  it('Dockerfile keeps the SSH client (git over SSH)', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('openssh-client'));
  });

  it('docker-compose.yml does not start sshd', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes('sshd'));
    assert.ok(content.includes(`bash -c "tmux new-session -d -s claude 'claude --dangerously-skip-permissions' && sleep infinity"`));
  });

  it('devcontainer service publishes no ports', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes('ports:'));
    assert.ok(!content.includes(':22"'));
  });

  it('no port maps to container port 22 even with services', () => {
    generate(opts({ services: ['postgres', 'mongo', 'redis', 'azurite'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes(':22"'));
  });

  // --- Port forwarding ---

  it('forwardPorts is empty without services', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.deepEqual(json.forwardPorts, []);
    assert.deepEqual(json.portsAttributes, {});
  });

  it('forwardPorts uses "service:port" form for services', () => {
    generate(opts({ services: ['postgres', 'redis'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.ok(json.forwardPorts.includes('postgres:5432'));
    assert.ok(json.forwardPorts.includes('redis:6379'));
    // holá čísla služeb se už nepoužívají (tunelovala by localhost devcontaineru)
    assert.ok(!json.forwardPorts.includes(5432));
    assert.ok(!json.forwardPorts.includes(6379));
  });

  it('portsAttributes is keyed by "service:port" with service labels', () => {
    generate(opts({ services: ['postgres', 'redis'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.equal(json.portsAttributes['postgres:5432'].label, 'PostgreSQL');
    assert.equal(json.portsAttributes['postgres:5432'].onAutoForward, 'silent');
    assert.equal(json.portsAttributes['redis:6379'].label, 'Redis');
  });

  it('azurite multi-port forwarding via "service:port"', () => {
    generate(opts({ services: ['azurite'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.ok(json.forwardPorts.includes('azurite:10000'));
    assert.ok(json.forwardPorts.includes('azurite:10001'));
    assert.ok(json.forwardPorts.includes('azurite:10002'));
    assert.equal(json.portsAttributes['azurite:10000'].label, 'Azurite (Azure Storage Emulator)');
  });

  it('otherPortsAttributes remains ignore', () => {
    generate(opts({ services: ['postgres'] }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.equal(json.otherPortsAttributes.onAutoForward, 'ignore');
  });

  // --- Git credentials isolation ---

  it('devcontainer.json has remoteEnv to block VS Code git credential forwarding', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.equal(json.remoteEnv.VSCODE_GIT_ASKPASS_MAIN, '');
    assert.equal(json.remoteEnv.VSCODE_GIT_ASKPASS_NODE, '');
    assert.equal(json.remoteEnv.VSCODE_GIT_ASKPASS_EXTRA_ARGS, '');
    assert.equal(json.remoteEnv.VSCODE_GIT_IPC_HANDLE, '');
    assert.equal(json.remoteEnv.GIT_ASKPASS, '');
  });

  it('devcontainer.json disables git.terminalAuthentication', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.equal(json.customizations.vscode.settings['git.terminalAuthentication'], false);
  });

  it('devcontainer.json sets gitCredentialHelperConfigLocation to none', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = parseJsonc(content);
    assert.equal(json.customizations.vscode.settings['dev.containers.gitCredentialHelperConfigLocation'], 'none');
  });

  it('Dockerfile sets git credential.helper to store', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes("credential.helper 'store --file /home/node/.git-credentials'"));
  });

  // --- Include compose ---

  it('no include section by default', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(!content.includes('include:'));
  });

  it('includeCompose adds include section with project compose path', () => {
    generate(opts({ includeCompose: true }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('include:'));
    assert.ok(content.includes('../../testproject/docker-compose.yml'));
  });

  // --- gh CLI ---

  it('Dockerfile installs gh CLI from official apt repo', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('cli.github.com/packages'));
    assert.ok(content.includes('apt-get install -y --no-install-recommends gh'));
  });

  it('Dockerfile exports GH_TOKEN from .git-credentials in .zshenv', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('~/.zshenv'));
    assert.ok(content.includes('export GH_TOKEN'));
    assert.ok(content.includes('@github\\.com'));
  });

  it('GH_TOKEN snippet is in .zshenv, not .zshrc', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    const lines = content.split('\n');
    assert.ok(lines.some(l => l.includes('GH_TOKEN')), 'expected a line containing GH_TOKEN');
    assert.ok(/RUN cat >> ~\/\.zshenv <<'EOF'/.test(content), 'GH_TOKEN snippet must append to ~/.zshenv');
    assert.ok(!lines.some(l => /GH_TOKEN/.test(l) && />>\s*~\/\.zshrc/.test(l)), 'GH_TOKEN must not be appended to .zshrc');
  });

  // --- Persistent git credentials (PAT) ---

  it('docker-compose.yml mounts the per-devcontainer git-credentials volume', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('testproject-git-credentials:/home/node/.gitcreds'));
  });

  it('docker-compose.yml declares git-credentials volume as external', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(/testproject-git-credentials:\n\s+external: true/.test(content));
  });

  it('git-credentials volume name follows the compose project name', () => {
    generate(opts({ name: 'mvz' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('mvz-git-credentials:/home/node/.gitcreds'));
    assert.ok(!content.includes('testproject-git-credentials'));
  });

  it('Dockerfile pre-creates .gitcreds dir with node ownership', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('mkdir -p /home/node/.gitcreds && chown node:node /home/node/.gitcreds'));
  });

  it('Dockerfile symlinks the canonical ~/.git-credentials into the volume', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('ln -sf /home/node/.gitcreds/.git-credentials /home/node/.git-credentials'));
  });

  it('init.sh creates the external git-credentials volume if missing', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'init.sh'), 'utf-8');
    assert.ok(content.includes('docker volume inspect testproject-git-credentials'));
    assert.ok(content.includes('docker volume create testproject-git-credentials'));
  });

  // --- Generated README ---

  it('README.md contains project name, repo and branch', () => {
    generate(opts({ branch: 'develop' }));
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('# testproject — devcontainer'));
    assert.ok(content.includes('git@github.com:test/repo.git'));
    assert.ok(content.includes('branch `develop`'));
  });

  it('README.md documents the stack', () => {
    generate(opts({ stack: 'python' }));
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('Python'));
    assert.ok(content.includes('python:3.12'));
    assert.ok(content.includes('Node.js (pro Claude Code)'));
  });

  it('README.md explains tmux and the PAT echo command', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('tmux attach -t claude'));
    assert.ok(content.includes('> ~/.git-credentials'));
    assert.ok(content.includes('testproject-git-credentials'));
  });

  it('README.md has firewall section by default', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('## Firewall'));
  });

  it('README.md drops firewall section with fullInternet', () => {
    generate(opts({ fullInternet: true }));
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(!content.includes('## Firewall'));
    assert.ok(content.includes('plný přístup k internetu'));
  });

  it('README.md lists selected services', () => {
    generate(opts({ services: ['postgres', 'redis'] }));
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('PostgreSQL'));
    assert.ok(content.includes('Redis'));
    assert.ok(content.includes('pgdata'));
  });

  it('README.md has the Claude context section only with localClaude', () => {
    generate(opts());
    let content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(!content.includes('## Claude kontext'));
    rmSync(join(outputDir, 'README.md'));
    generate(opts({ localClaude: true }));
    content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('## Claude kontext'));
    assert.ok(content.includes('.workspace-claude/'));
    assert.ok(content.includes('.project-claude/'));
  });

  it('README.md documents the Windows prerequisites', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('## Windows'));
    assert.ok(content.includes('gitforwindows.org'));
    assert.ok(content.includes('git update-index --chmod=+x .devcontainer/init'));
  });

  it('README.md does not advertise SSH into the container or JetBrains', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(!content.includes('JetBrains'));
    assert.ok(!content.includes('2222'));
    assert.ok(!/SSH na portu|Gateway/.test(content));
  });

  it('README.md documents access via docker exec + tmux', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('nemá vlastní SSH server'));
    assert.ok(content.includes('docker exec -it <kontejner> zsh'));
    assert.ok(content.includes('tmux attach -t claude'));
  });

  it('README.md lists the devcontainer repo among workspace repositories', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, 'README.md'), 'utf-8');
    assert.ok(content.includes('testproject-devcontainer'));
    assert.ok(content.includes('/workspace/testproject'));
  });

  // --- Multi-root workspace ---

  it('generates a <name>.code-workspace file', () => {
    generate(opts());
    assert.ok(existsSync(join(outputDir, 'testproject.code-workspace')));
  });

  it('code-workspace is named after the project', () => {
    generate(opts({ name: 'mvz' }));
    assert.ok(existsSync(join(outputDir, 'mvz.code-workspace')));
    assert.ok(!existsSync(join(outputDir, 'testproject.code-workspace')));
  });

  it('code-workspace lists both repos as folders', () => {
    generate(opts());
    const json = JSON.parse(readFileSync(join(outputDir, 'testproject.code-workspace'), 'utf-8'));
    const paths = json.folders.map((f) => f.path);
    assert.deepEqual(paths, ['testproject', 'testproject-devcontainer']);
  });

  it('code-workspace enables automatic tasks', () => {
    generate(opts());
    const json = JSON.parse(readFileSync(join(outputDir, 'testproject.code-workspace'), 'utf-8'));
    assert.equal(json.settings['task.allowAutomaticTasks'], 'on');
  });

  it('code-workspace has a folderOpen tmux auto-attach task', () => {
    generate(opts());
    const json = JSON.parse(readFileSync(join(outputDir, 'testproject.code-workspace'), 'utf-8'));
    const task = json.tasks.tasks[0];
    assert.equal(task.runOptions.runOn, 'folderOpen');
    assert.ok(task.command.includes('tmux attach -t claude'));
    assert.ok(task.command.includes('claude --dangerously-skip-permissions'));
  });

  it('docker-compose mounts the customer repo under /workspace/<name>', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('../../testproject:/workspace/testproject:cached'));
  });

  it('docker-compose mounts the devcontainer repo into the workspace', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('../../testproject-devcontainer:/workspace/testproject-devcontainer:cached'));
  });

  it('docker-compose mounts the code-workspace file at /workspace root', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('testproject.code-workspace:/workspace/testproject.code-workspace:cached'));
  });

  // --- Cross-platform (Windows) ---

  it('generates .gitattributes pinning line endings', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.gitattributes'), 'utf-8');
    assert.ok(content.includes('* text=auto'));
    assert.ok(content.includes('*.sh            text eol=lf'));
    assert.ok(content.includes('Dockerfile*     text eol=lf'));
    assert.ok(content.includes('.devcontainer/init  text eol=lf'));
    assert.ok(content.includes('*.cmd           text eol=crlf'));
  });

  it('init.cmd is written with CRLF line endings', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'init.cmd'), 'utf-8');
    assert.ok(content.includes('\r\n'), 'init.cmd musí mít CRLF');
    assert.ok(!/[^\r]\n/.test(content), 'init.cmd nesmí obsahovat osamocené LF');
    assert.ok(content.includes('%~dp0init.sh'));
  });

  it('init wrapper is executable, LF-only and delegates to init.sh', () => {
    generate(opts());
    const initPath = join(outputDir, '.devcontainer', 'init');
    const content = readFileSync(initPath, 'utf-8');
    assert.ok(!content.includes('\r'), 'init musí mít LF');
    assert.ok(content.includes('exec "$(dirname "$0")/init.sh"'));
    // Na Windows je chmod no-op → exec bit se musí doplnit
    // přes `git update-index --chmod=+x .devcontainer/init` (viz README).
    assert.ok(statSync(initPath).mode & 0o100, 'init should be executable');
  });

  it('initializeCommand dispatches between Windows and POSIX wrappers', () => {
    for (const extra of [{}, { fullInternet: true }]) {
      rmSync(outputDir, { recursive: true, force: true });
      generate(opts(extra));
      const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
      // Raw podoba: v JSON zdroji musí být backslash zdvojený.
      assert.ok(content.includes('.devcontainer\\\\init.cmd || .devcontainer/init'));
      const json = parseJsonc(content);
      assert.equal(json.initializeCommand, '.devcontainer\\init.cmd || .devcontainer/init');
    }
  });

  // --- Workspace-level Claude kontext (--local-claude) ---

  it('local-claude mounts workspace-level .claude at the container cwd', () => {
    generate(opts({ localClaude: true }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('.workspace-claude:/workspace/.claude:cached'));
    assert.ok(content.includes('.project-claude:/workspace/testproject/.claude:cached'));
  });

  it('local-claude seeds workspace CLAUDE.md pointing at the project one', () => {
    generate(opts({ localClaude: true }));
    const workspaceMd = readFileSync(join(outputDir, '.workspace-claude', 'CLAUDE.md'), 'utf-8');
    // @ import (ne jen markdown odkaz) — projektový kontext se musí natáhnout
    // do kontextu i při cwd /workspace.
    assert.match(workspaceMd, /^@\.\.\/testproject\/\.claude\/CLAUDE\.md$/m);
    assert.ok(existsSync(join(outputDir, '.project-claude', 'CLAUDE.md')));
  });

  it('no local Claude context without --local-claude', () => {
    generate(opts());
    assert.ok(!existsSync(join(outputDir, '.workspace-claude')));
    assert.ok(!existsSync(join(outputDir, '.project-claude')));
  });
});

describe('nameFromRepo', () => {
  it('extracts name from SSH URL', () => {
    assert.equal(nameFromRepo('git@github.com:zakaznik/mujprojekt.git'), 'mujprojekt');
  });

  it('extracts name from HTTPS URL', () => {
    assert.equal(nameFromRepo('https://github.com/zakaznik/mujprojekt.git'), 'mujprojekt');
  });

  it('handles URL without .git suffix', () => {
    assert.equal(nameFromRepo('https://github.com/zakaznik/mujprojekt'), 'mujprojekt');
  });

  it('throws on empty result', () => {
    assert.throws(() => nameFromRepo(''), /Cannot derive/);
  });
});
