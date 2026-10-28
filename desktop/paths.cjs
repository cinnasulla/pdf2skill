const path = require('node:path');

function assetPath(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relative);
  const check = path.relative(root, resolved);
  if (!check || check.startsWith('..') || path.isAbsolute(check) || decoded.includes('\0')) {
    throw new Error('Invalid asset path');
  }
  return resolved;
}

function isolatedEnvironment(root, token) {
  // Explicit allowlist: never inherit API keys, PYTHONPATH, NODE_OPTIONS or shell proxies.
  const env = {
    HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    GRADIO_TEMP_DIR: path.join(root, 'tmp', 'gradio'),
    HF_HOME: path.join(root, 'cache', 'huggingface'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PDF2SKILL_DESKTOP_DATA: root,
    PDF2SKILL_DESKTOP_TOKEN: token,
    LANG: 'en_US.UTF-8'
  };
  for (const key of ['SYSTEMROOT', 'SSL_CERT_FILE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

module.exports = { assetPath, isolatedEnvironment };
