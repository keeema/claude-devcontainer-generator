#!/usr/bin/env node

import { Command } from 'commander';
import { generate, printInstructions, nameFromRepo } from './generator.js';

const program = new Command();

program
  .name('devcontainer-generator')
  .description('Generate devcontainer repositories with Claude Code sandbox')
  .option('--name <name>', 'Project name (derived from repo URL if omitted)')
  .requiredOption('--repo <url>', 'Git repository URL')
  .option('--branch <branch>', 'Git branch', 'main')
  .option('--stack <stack>', 'SDK/runtime stack (nodejs, python, dotnet)', 'nodejs')
  .option('--services <services>', 'Comma-separated services (postgres, mongo, redis, azurite)', '')
  .option('--full-internet', 'Allow full internet access (skip firewall)', false)
  .option('--include-compose', 'Include project docker-compose.yml via compose include', false)
  .option('--local-claude', 'Mount .claude from devcontainer repo (.project-claude/) instead of Docker volume', false)
  .option('--ssh-port <port>', 'SSH port for JetBrains IDE access (default: 2222)', '2222')
  .requiredOption('--output <path>', 'Output directory path')
  .action((options) => {
    try {
      const services = options.services ? options.services.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (!options.name) {
        options.name = nameFromRepo(options.repo);
      }
      const sshPort = parseInt(options.sshPort, 10);
      generate({ ...options, services, sshPort });
      printInstructions(options.name, options.output, { localClaude: options.localClaude, sshPort });
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
