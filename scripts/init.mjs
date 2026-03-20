#!/usr/bin/env node

/**
 * Autodev Plugin — Project Initializer
 *
 * Creates .workflow/ directory with default config files.
 * Run: node <plugin-path>/scripts/init.mjs
 *
 * Options:
 *   --name <name>       Project name (default: folder name)
 *   --language <lang>   Output language: en, vi, ja, zh (default: en)
 *   --email <email>     Notification email (default: null)
 *   --specs-dir <path>  Specs directory (default: docs/specs)
 *   --plans-dir <path>  Plans directory (default: docs/plans)
 *   --test-cmd <cmd>    Test command (default: npm test)
 *   --force             Overwrite existing config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = join(__dirname, '..');
const cwd = process.cwd();

// Parse args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}
const force = args.includes('--force');

const projectName = getArg('name', basename(cwd));
const language = getArg('language', 'en');
const email = getArg('email', 'null');
const specsDir = getArg('specs-dir', 'docs/specs');
const plansDir = getArg('plans-dir', 'docs/plans');
const testCmd = getArg('test-cmd', 'npm test');

const workflowDir = join(cwd, '.workflow');

// 1. Create .workflow/ directory
if (!existsSync(workflowDir)) {
  mkdirSync(workflowDir, { recursive: true });
  console.log('✓ Created .workflow/');
} else {
  console.log('• .workflow/ already exists');
}

// 2. Copy reactions.yaml (with customization)
const reactionsPath = join(workflowDir, 'reactions.yaml');
if (!existsSync(reactionsPath) || force) {
  let template = readFileSync(join(pluginRoot, 'templates', 'reactions.yaml'), 'utf-8');
  template = template.replace('name: "my-project"', `name: "${projectName}"`);
  template = template.replace('language: "en"', `language: "${language}"`);
  template = template.replace('specs_dir: "docs/specs"', `specs_dir: "${specsDir}"`);
  template = template.replace('plans_dir: "docs/plans"', `plans_dir: "${plansDir}"`);
  template = template.replace('test_command: "npm test"', `test_command: "${testCmd}"`);
  if (email !== 'null') {
    template = template.replace('email: null', `email: "${email}"`);
  }
  writeFileSync(reactionsPath, template);
  console.log('✓ Created .workflow/reactions.yaml');
} else {
  console.log('• .workflow/reactions.yaml already exists (use --force to overwrite)');
}

// 3. Copy model-registry.json
const modelRegistryPath = join(workflowDir, 'model-registry.json');
if (!existsSync(modelRegistryPath) || force) {
  const template = readFileSync(join(pluginRoot, 'templates', 'model-registry.json'), 'utf-8');
  writeFileSync(modelRegistryPath, template);
  console.log('✓ Created .workflow/model-registry.json');
} else {
  console.log('• .workflow/model-registry.json already exists (use --force to overwrite)');
}

// 4. Create spec/plan directories
for (const dir of [specsDir, plansDir]) {
  const fullPath = join(cwd, dir);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
    // Create .gitkeep so empty dir is tracked
    writeFileSync(join(fullPath, '.gitkeep'), '');
    console.log(`✓ Created ${dir}/`);
  } else {
    console.log(`• ${dir}/ already exists`);
  }
}

// 5. Add .workflow/ to .gitignore
const gitignorePath = join(cwd, '.gitignore');
if (existsSync(gitignorePath)) {
  const content = readFileSync(gitignorePath, 'utf-8');
  if (!content.includes('.workflow/')) {
    appendFileSync(gitignorePath, '\n# Autodev workflow state (runtime, not committed)\n.workflow/\n');
    console.log('✓ Added .workflow/ to .gitignore');
  } else {
    console.log('• .workflow/ already in .gitignore');
  }
} else {
  writeFileSync(gitignorePath, '# Autodev workflow state (runtime, not committed)\n.workflow/\n');
  console.log('✓ Created .gitignore with .workflow/');
}

console.log(`
═══════════════════════════════════════════
  Autodev initialized for: ${projectName}
═══════════════════════════════════════════
  Language:   ${language}
  Specs dir:  ${specsDir}
  Plans dir:  ${plansDir}
  Test cmd:   ${testCmd}
  Email:      ${email === 'null' ? 'disabled' : email}

  Config:     .workflow/reactions.yaml
  Models:     .workflow/model-registry.json

  Next steps:
  1. Edit .workflow/reactions.yaml to customize
  2. Run /autodev "your feature request"
═══════════════════════════════════════════
`);
