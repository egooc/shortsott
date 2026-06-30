function requireApiKey(keyName) {
  const value = process.env[keyName];
  if (!value) {
    const err = new Error(`Missing API key: ${keyName}`);
    err.status = 400;
    err.code = 'API_KEY_MISSING';
    throw err;
  }
  return value;
}

module.exports = { requireApiKey };
