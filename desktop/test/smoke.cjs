// Real packaged-app checks: OPFS persistence, proxy auth, shutdown and cleanup.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const executable = process.argv[2];
  assert(executable, 'Supply the packaged macOS executable');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf2skill-smoke-'));
  try {
    for (const [previous, clean] of [[false, false], [true, false], [true, true]]) {
      const child = spawn(executable, ['--smoke-test', ...(clean ? ['--smoke-cleanup'] : [])], {
        env: { ...process.env, PDF2SKILL_TEST_DATA_DIR: root }, stdio: 'inherit'
      });
      let timer;
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Packaged app timed out')); }, 90000);
        child.once('error', reject);
        child.once('exit', resolve);
      }).finally(() => clearTimeout(timer));
      assert.equal(code, 0);
      if (clean) {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (!(await fs.stat(root).catch(() => null))) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(await fs.stat(root).catch(() => null), null, 'Cleanup must remove the entire app data root');
        console.log('Application cleanup check passed');
        continue;
      }
      const report = JSON.parse(await fs.readFile(path.join(root, 'smoke-result.json'), 'utf8'));
      assert.equal(report.previous, previous, 'OPFS must survive application restart');
      assert.equal(report.unauthenticatedStatus, 401);
      await assert.rejects(fetch(report.backendURL + '/api/health', { signal: AbortSignal.timeout(1500) }),
        'Backend must stop when the app exits');
      console.log('Packaged application checks passed:', report);
      if (previous) {
        await fs.rm(path.join(root, 'smoke-result.json'));
        const crashing = spawn(executable, ['--smoke-test', '--smoke-crash-ready'], {
          env: { ...process.env, PDF2SKILL_TEST_DATA_DIR: root }, stdio: 'inherit'
        });
        try {
          let crashReport;
          for (let attempt = 0; attempt < 450; attempt++) {
            crashReport = await fs.readFile(path.join(root, 'smoke-result.json'), 'utf8').catch(() => null);
            if (crashReport) break;
            if (crashing.exitCode !== null) throw new Error('Crash-test application exited early');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert(crashReport, 'Crash-test application must become ready');
          const crashedURL = JSON.parse(crashReport).backendURL;
          const exited = new Promise(resolve => crashing.once('exit', resolve));
          crashing.kill('SIGKILL');
          await exited;
          let stopped = false;
          for (let attempt = 0; attempt < 50; attempt++) {
            try { await fetch(crashedURL + '/api/health', { signal: AbortSignal.timeout(500) }); }
            catch { stopped = true; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert(stopped, 'Backend must stop even when the parent is killed');
          console.log('Parent crash shutdown check passed');
        } finally { if (crashing.exitCode === null && crashing.signalCode === null) crashing.kill('SIGKILL'); }
      }
    }
  } catch (error) {
    const details = await fs.readFile(path.join(root, 'smoke-error.txt'), 'utf8').catch(() => '');
    throw new Error(`${error.stack}\n${details}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
