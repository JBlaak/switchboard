// Question 4: how long does one `claude -p` capture take with --strict-mcp-config and a temp config
// holding only the BlaakTasks HTTP server (Authorization header)? Uses the read-only `list` tool so
// nothing is created. The token is never printed and never on argv.
//
//   node spike/quick-ask/capture-timing.js [coldRuns=3] [warmRuns=2]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const COLD = Number(process.argv[2] || 3);
const WARM = Number(process.argv[3] || 2);
const PROMPT = 'Call the mcp__blaaktasks__list tool exactly once (use default arguments), then reply with only the number of items it returned, nothing else.';

const claudeJson = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
const entry = claudeJson.mcpServers?.blaaktasks;
if (!entry) { console.log('no mcpServers.blaaktasks in ~/.claude.json'); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-spike-'));
const configPath = path.join(dir, 'mcp.json');
// Copied unchanged: { type: 'http', url, headers: { Authorization: 'Bearer …' } }
fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { blaaktasks: entry } }), { mode: 0o600 });
console.log('temp config mode', (fs.statSync(configPath).mode & 0o777).toString(8), 'keys', Object.keys(entry).join(','));

const common = ['--model', 'haiku', '--tools', '', '--allowedTools', 'mcp__blaaktasks__list', '--strict-mcp-config',
  '--mcp-config', configPath, '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands'];
const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
process.on('exit', () => { cleanup(); console.log('temp config deleted:', !fs.existsSync(configPath)); });

function cold() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const p = spawn('claude', ['-p', ...common, '--output-format', 'json', PROMPT], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      let j = {};
      try { j = JSON.parse(out); } catch {}
      resolve({ code, wall: Math.round(wall), duration_ms: j.duration_ms, duration_api_ms: j.duration_api_ms, num_turns: j.num_turns,
        is_error: j.is_error, result: String(j.result ?? '').slice(0, 40), denials: j.permission_denials?.length, stderr: err.slice(0, 200) });
    });
  });
}

function warm() {
  return new Promise((resolve) => {
    const tSpawn = process.hrtime.bigint();
    const ms = (t) => Math.round(Number(t - tSpawn) / 1e6);
    const p = spawn('claude', ['-p', ...common, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', tInit = null, mcpStatus = null, tSend = null, toolUses = 0;
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') { tInit = process.hrtime.bigint(); mcpStatus = ev.mcp_servers; }
        if (ev.type === 'assistant') toolUses += (ev.message?.content || []).filter((c) => c.type === 'tool_use').length;
        if (ev.type === 'result') {
          const tDone = process.hrtime.bigint();
          p.stdin.end();
          resolve({ initAfterSpawn: tInit ? ms(tInit) : null, mcpStatus, sendToResult: Math.round(Number(tDone - tSend) / 1e6),
            duration_ms: ev.duration_ms, duration_api_ms: ev.duration_api_ms, num_turns: ev.num_turns, toolUses,
            is_error: ev.is_error, result: String(ev.result ?? '').slice(0, 40) });
        }
      }
    });
    setTimeout(() => {
      tSend = process.hrtime.bigint();
      p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } }) + '\n');
    }, 3000);
  });
}

(async () => {
  for (let i = 1; i <= COLD; i++) console.log(`cold ${i}`, JSON.stringify(await cold()));
  for (let i = 1; i <= WARM; i++) console.log(`warm ${i}`, JSON.stringify(await warm()));
})();
