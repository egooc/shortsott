const test = require('node:test');
const assert = require('node:assert');

// The breaker reads env at call time, so each case sets what it needs and restores after.
function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const svc = require('../server/services/geminiMidformService.js');

test('a Vertex request is refused before it reaches the network', async () => {
  await withEnv({ MIDFORM_ALLOW_VERTEX: undefined, GEMINI_AUTH_MODE: 'vertex_adc' }, async () => {
    await assert.rejects(
      () => svc._test.fetchVertexWithRateBackoff('https://aiplatform.googleapis.com/v1/x', {}),
      (error) => {
        assert.equal(error.code, 'VERTEX_SPEND_BLOCKED');
        assert.equal(error.status, 403);
        return true;
      }
    );
  });
});

test('an empty or wrong value is not an opt-in', async () => {
  for (const value of ['', '0', 'true', 'yes', 'false']) {
    await withEnv({ MIDFORM_ALLOW_VERTEX: value, GEMINI_AUTH_MODE: 'vertex_adc' }, async () => {
      await assert.rejects(
        () => svc._test.fetchVertexWithRateBackoff('https://aiplatform.googleapis.com/v1/x', {}),
        (error) => error.code === 'VERTEX_SPEND_BLOCKED',
        `MIDFORM_ALLOW_VERTEX=${JSON.stringify(value)} must not open the breaker`
      );
    });
  }
});

test('the message points at the switches, not just the block', async () => {
  await withEnv({ MIDFORM_ALLOW_VERTEX: undefined, GEMINI_AUTH_MODE: 'vertex_adc' }, async () => {
    await assert.rejects(
      () => svc._test.fetchVertexWithRateBackoff('https://aiplatform.googleapis.com/v1/x', {}),
      (error) => {
        assert.match(error.message, /MIDFORM_COMPRESS_LLM/);
        assert.match(error.message, /MIDFORM_VISION_LLM/);
        assert.match(error.message, /MIDFORM_ALLOW_VERTEX=1/);
        return true;
      }
    );
  });
});

test('no token is minted for a provider we may not spend on', async () => {
  await withEnv({ MIDFORM_ALLOW_VERTEX: undefined, GEMINI_AUTH_MODE: 'vertex_adc' }, async () => {
    await assert.rejects(
      () => svc._test.getVertexAccessToken(),
      (error) => error.code === 'VERTEX_SPEND_BLOCKED'
    );
  });
});

test('the breaker opens when the owner explicitly asks for it', () => {
  withEnv({ MIDFORM_ALLOW_VERTEX: '1' }, () => {
    assert.equal(svc._test.vertexSpendAllowed(), true);
  });
});
