const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assetPath, isolatedEnvironment } = require('../paths.cjs');

test('assets stay within the bundled web root', () => {
  assert.equal(assetPath('/app/web', '/'), '/app/web/index.html');
  assert.equal(assetPath('/app/web', '/assets/main.js'), '/app/web/assets/main.js');
  for (const traversal of ['/../secret', '/%2e%2e/secret', '/%00secret']) {
    assert.throws(() => assetPath('/app/web', traversal));
  }
});

test('backend does not inherit shell credentials or Python/Node/proxy configuration', () => {
  process.env.UNRELATED_API_KEY = 'do-not-inherit';
  process.env.PYTHONPATH = '/system-modules';
  process.env.HTTPS_PROXY = 'http://unrelated-proxy';
  const env = isolatedEnvironment('/private/app-data', 'random-token');
  assert.equal(env.UNRELATED_API_KEY, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.HOME, '/private/app-data/home');
  assert.equal(env.TMPDIR, '/private/app-data/tmp');
});
