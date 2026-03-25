import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Check if proxy is configured in reactions.yaml
const reactionsFile = join(cwd, '.workflow', 'reactions.yaml');
if (!existsSync(reactionsFile)) process.exit(0);

const content = readFileSync(reactionsFile, 'utf-8');

// Look for proxy config: proxy: { enabled: true, port: N, model: "..." }
const enabledMatch = content.match(/proxy:\s*\n\s+enabled:\s*(true)/);
if (!enabledMatch) process.exit(0);

const portMatch = content.match(/proxy:\s*\n(?:\s+\w+:.*\n)*?\s+port:\s*(\d+)/);
const modelMatch = content.match(/proxy:\s*\n(?:\s+\w+:.*\n)*?\s+model:\s*"?([^"\s]+)"?/);
const port = portMatch ? portMatch[1] : '4141';
const model = modelMatch ? modelMatch[1] : 'gpt-5.4';

// Check if port is already in use
try {
  execSync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/v1/messages 2>/dev/null`, {
    encoding: 'utf-8', timeout: 2000
  });
  // Port responding — proxy already running
  console.log(`\u25B8 Proxy already running on localhost:${port}`);
  process.exit(0);
} catch {
  // Port not responding — need to start
}

// Start proxy in background
const proxyScript = join(__dirname, '..', 'scripts', 'proxy.mjs');
if (!existsSync(proxyScript)) {
  console.log('\u26A0 proxy.mjs not found');
  process.exit(0);
}

try {
  const child = spawn('node', [proxyScript, '--port', port, '--target-model', model], {
    detached: true,
    stdio: 'ignore',
    cwd,
  });
  child.unref();
  console.log(`\u25B8 Proxy started: localhost:${port} \u2192 ${model}`);
} catch (err) {
  console.log(`\u26A0 Proxy start failed: ${err.message}`);
}
