import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generate, extractServiceVolumes, nameFromRepo } from '../src/generator.js';

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
    assert.ok(existsSync(join(outputDir, 'project.yml')));
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
    const json = JSON.parse(content);
    const ext = json.customizations.vscode.extensions;
    assert.ok(ext.includes('anthropic.claude-code'));
    assert.ok(ext.includes('dbaeumer.vscode-eslint'));
    assert.ok(ext.includes('esbenp.prettier-vscode'));
    assert.ok(ext.includes('eamodio.gitlens'));
    assert.ok(ext.includes('streetsidesoftware.code-spell-checker'));
  });

  it('nodejs stack has jest extension', () => {
    generate(opts({ stack: 'nodejs' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = JSON.parse(content);
    assert.ok(json.customizations.vscode.extensions.includes('orta.vscode-jest'));
  });

  it('python stack has python extension', () => {
    generate(opts({ stack: 'python' }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = JSON.parse(content);
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
    const json = JSON.parse(content);
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
    const json = JSON.parse(content);
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
    assert.ok(content.includes('.project-claude:/workspace/.claude:cached'));
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

  // --- SSH server ---

  it('Dockerfile contains openssh-server', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'Dockerfile'), 'utf-8');
    assert.ok(content.includes('openssh-server'));
  });

  it('docker-compose.yml contains sshd in command', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('sshd'));
  });

  it('docker-compose.yml contains default SSH port 2222:22', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('2222:22'));
  });

  it('custom SSH port is propagated to docker-compose.yml', () => {
    generate(opts({ sshPort: 3333 }));
    const content = readFileSync(join(outputDir, '.devcontainer', 'docker-compose.yml'), 'utf-8');
    assert.ok(content.includes('3333:22'));
    assert.ok(!content.includes('2222:22'));
  });

  // --- Git credentials isolation ---

  it('devcontainer.json has remoteEnv to block VS Code git credential forwarding', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = JSON.parse(content);
    assert.equal(json.remoteEnv.VSCODE_GIT_ASKPASS_MAIN, '');
    assert.equal(json.remoteEnv.VSCODE_GIT_ASKPASS_NODE, '');
    assert.equal(json.remoteEnv.VSCODE_GIT_ASKPASS_EXTRA_ARGS, '');
    assert.equal(json.remoteEnv.VSCODE_GIT_IPC_HANDLE, '');
    assert.equal(json.remoteEnv.GIT_ASKPASS, '');
  });

  it('devcontainer.json disables git.terminalAuthentication', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = JSON.parse(content);
    assert.equal(json.customizations.vscode.settings['git.terminalAuthentication'], false);
  });

  it('devcontainer.json sets gitCredentialHelperConfigLocation to none', () => {
    generate(opts());
    const content = readFileSync(join(outputDir, '.devcontainer', 'devcontainer.json'), 'utf-8');
    const json = JSON.parse(content);
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
