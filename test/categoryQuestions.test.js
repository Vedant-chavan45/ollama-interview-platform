'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { QUESTION_CATEGORIES, QUESTION_COUNT_PER_CATEGORY, getQuestionCategory } = require('../src/services/questionCategories');
const { buildCategoryQuestionPrompt, generateCategoryQuestions, heuristicFallbackCategoryQuestions } = require('../src/services/questionGeneratorService');
const { validateGeneratedCategoryQuestions, validateGeneratedQuestions } = require('../src/services/questionValidatorService');
const { buildInterviewPlan } = require('../src/services/interviewPlannerService');

const context = {
  targetRole: 'Backend Developer', interviewType: 'Technical', skills: ['Node.js', 'MongoDB'],
  projects: [{ title: 'Resume Parser Platform', technologies: ['Node.js', 'MongoDB'], description: 'Built a resume parsing platform.' }],
  experience: [{ role: 'Developer Intern', organisation: 'Example Co', responsibilities: ['Designed REST APIs.'] }],
  education: [{ degree: 'B.Tech', institution: 'Example University' }],
};
const plan = buildInterviewPlan(context);
const sets = {
  domain_fundamentals: (i) => `How would you apply Node.js when evaluating design trade-offs for case ${i}?`,
  technical_concepts: (i) => `How would you test a Node.js integration path for case ${i}?`,
  project_deep_dive: (i) => `Which project decision in Resume Parser Platform would you revisit for case ${i}?`,
  professional_experience: (i) => `Which responsibility from your Developer Intern experience would you explain for case ${i}?`,
  applied_scenarios: (i) => `Suppose a Node.js incident occurred in scenario ${i}; how would you respond?`,
  behavioral_collaboration: (i) => `How did you communicate with a team about feedback in situation ${i}?`,
};

test('category prompts use distinct category instructions, planner priorities, role and resume evidence', () => {
  const prompts = Object.keys(QUESTION_CATEGORIES).map((id) => buildCategoryQuestionPrompt(context, id, plan));
  assert.equal(QUESTION_COUNT_PER_CATEGORY, 6);
  assert.equal(new Set(prompts).size, 6);
  for (let index = 0; index < prompts.length; index += 1) {
    assert.match(prompts[index], /exactly 6 distinct interview questions/);
    assert.match(prompts[index], /Backend Developer/);
    assert.match(prompts[index], /MongoDB/);
    assert.match(prompts[index], /PLAN/);
    assert.match(prompts[index], /RESUME/);
  }
  assert.match(prompts[4], /hypothetical situations/);
  assert.throws(() => buildCategoryQuestionPrompt(context, 'unsupported'), { code: 'invalid-category' });
  assert.equal(getQuestionCategory('toString'), null);
});

test('category-aware validation assigns one category type without requiring mixed distribution', () => {
  const category = getQuestionCategory('technical_concepts');
  const result = validateGeneratedCategoryQuestions({ questions: Array.from({ length: 6 }, (_, i) => sets.technical_concepts(i + 1)) }, context, plan, category);
  assert.equal(result.length, 6);
  assert.ok(result.every((question) => question.type === 'technical' && question.basedOn === 'Node.js'));
  assert.throws(() => validateGeneratedCategoryQuestions({ questions: Array.from({ length: 6 }, (_, i) => `What is Node.js case ${i}?`) }, context, plan, category), /Invalid generated questions/);
  assert.throws(() => validateGeneratedCategoryQuestions({ questions: Array.from({ length: 6 }, (_, i) => `Describe your favorite color for case ${i}?`) }, context, plan, category), /Invalid generated questions/);
});

test('category generator calls one category prompt and returns honestly labelled AI output', async (t) => {
  const request = t.mock.method(axios, 'post', async (_url, body) => {
    assert.match(body.prompt, /Applied Technical Scenarios/);
    assert.equal(body.format.properties.questions.minItems, QUESTION_COUNT_PER_CATEGORY);
    assert.equal(body.format.properties.questions.maxItems, QUESTION_COUNT_PER_CATEGORY);
    return { status: 200, data: { response: JSON.stringify({ questions: Array.from({ length: 6 }, (_, i) => sets.applied_scenarios(i + 1)) }) } };
  });
  const result = await generateCategoryQuestions(context, 'applied_scenarios');
  assert.equal(request.mock.callCount(), 1);
  assert.equal(result.category, 'applied_scenarios');
  assert.equal(result.source, 'ollama-llama3.2');
  assert.equal(result.status, 'ready');
  assert.ok(result.questions.every((question) => question.type === 'technical'));
});

test('all six deterministic category fallbacks return six relevant grounded questions and fallback attribution', () => {
  for (const categoryId of Object.keys(QUESTION_CATEGORIES)) {
    const result = heuristicFallbackCategoryQuestions(context, categoryId, plan);
    const category = getQuestionCategory(categoryId);
    assert.equal(result.source, 'heuristic-fallback');
    assert.equal(result.questions.length, QUESTION_COUNT_PER_CATEGORY);
    assert.ok(result.questions.every((question) => question.type === category.legacyType));
    assert.equal(new Set(result.questions.map((question) => question.question)).size, QUESTION_COUNT_PER_CATEGORY);
  }
});

test('legacy mixed question validation still requires its original distribution', () => {
  const mixed = ['technical', 'technical', 'project', 'project', 'experience', 'behavioral'];
  const questions = mixed.map((type, index) => ({ question: `How would you approach design case ${index}?`, type,
    basedOn: type === 'behavioral' ? 'general' : type === 'project' ? 'Resume Parser Platform' : type === 'experience' ? 'Developer Intern' : 'Node.js' }));
  assert.equal(validateGeneratedQuestions({ questions }, context, plan).length, 6);
  // Keep every item valid through schema, duplicate, and grounding checks so
  // this specifically exercises the legacy mixed-distribution requirement.
  const allTechnical = { questions: questions.map((question) => ({
    ...question,
    type: 'technical',
    basedOn: question.basedOn === 'general' ? 'Node.js' : question.basedOn,
  })) };
  let validationError;
  assert.throws(() => { validateGeneratedQuestions(allTechnical, context, plan); }, (error) => {
    validationError = error;
    return error.code === 'invalid-distribution';
  });
  assert.deepEqual(validationError.actualTypeCounts, { technical: 6, project: 0, behavioral: 0, experience: 0 });
  assert.deepEqual(validationError.expectedTypeCounts, { technical: 2, project: 2, experience: 1, behavioral: 1 });
});
