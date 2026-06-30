const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '../../.env');

function ensureEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, '', 'utf8');
  }
}

function readEnvMap() {
  ensureEnvFile();
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const map = {};

  raw
    .split(/\r?\n/)
    .filter(Boolean)
    .forEach((line) => {
      const idx = line.indexOf('=');
      if (idx > -1) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        map[key] = value;
      }
    });

  return map;
}

function writeEnvMap(map) {
  const lines = Object.entries(map).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 6) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}***`;
}

module.exports = {
  ENV_PATH,
  readEnvMap,
  writeEnvMap,
  maskSecret
};
