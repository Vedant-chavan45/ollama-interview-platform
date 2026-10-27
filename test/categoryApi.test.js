'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Resume = require('../src/models/Resume');
const generator = require('../src/services/questionGeneratorService');
const controller = require('../src/controllers/resumeController');

const userId = '000000000000000000000001';
const otherUser = '000000000000000000000002';
const resumeId = '100000000000000000000001';
const record = { resumeContext: { targetRole: 'Backend Developer', skills: ['Node.js'] } };
function res() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
function req(owner = userId, category = 'domain_fundamentals', id = resumeId, body) {
  return { user: { id: owner }, params: { id, category }, body };
}

test('category API rejects invalid categories and request data before generation', async (t) => {
  t.mock.method(Resume, 'findOne', () => { throw new Error('Invalid request must not query'); });
  const generate = t.mock.method(generator, 'generateCategoryQuestions', async () => { throw new Error('Must not generate'); });
  for (const [request, expected] of [[req(userId, 'invalid'), 400], [req(userId, 'domain_fundamentals', resumeId, { count: 2 }), 400]]) {
    const response = res();
    await controller.generateCategoryQuestions(request, response);
    assert.equal(response.statusCode, expected);
  }
  assert.equal(generate.mock.callCount(), 0);
});

test('category API verifies resume ownership and uses saved context', async (t) => {
  t.mock.method(Resume, 'findOne', (filter) => ({ lean: async () => filter.userId === userId ? record : null }));
  const generate = t.mock.method(generator, 'generateCategoryQuestions', async (context, category) => {
    assert.strictEqual(context, record.resumeContext);
    assert.equal(category, 'applied_scenarios');
    return { category, questions: [{ question: 'Suppose a failure occurred; what would you do?', type: 'technical', basedOn: 'Node.js' }], source: 'heuristic-fallback', status: 'ready' };
  });
  const foreign = res();
  await controller.generateCategoryQuestions(req(otherUser, 'applied_scenarios'), foreign);
  assert.equal(foreign.statusCode, 404);
  assert.equal(generate.mock.callCount(), 0);
  const response = res();
  await controller.generateCategoryQuestions(req(userId, 'applied_scenarios'), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.source, 'heuristic-fallback');
  assert.equal(response.body.category, 'applied_scenarios');
  assert.equal(generate.mock.callCount(), 1);
});

test('category API rejects overlapping generation for the same resume and category', async (t) => {
  t.mock.method(Resume, 'findOne', () => ({ lean: async () => record }));
  let finish;
  const generate = t.mock.method(generator, 'generateCategoryQuestions', () => new Promise((resolve) => { finish = resolve; }));
  const firstResponse = res();
  const first = controller.generateCategoryQuestions(req(), firstResponse);
  await new Promise((resolve) => setImmediate(resolve));
  const secondResponse = res();
  await controller.generateCategoryQuestions(req(), secondResponse);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(generate.mock.callCount(), 1);
  finish({ category: 'domain_fundamentals', questions: [], source: 'ollama-llama3.2', status: 'ready' });
  await first;
  assert.equal(firstResponse.statusCode, 200);
});
