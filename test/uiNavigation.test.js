'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');

test('analysis results expose exactly Overview and Resume details tabs', () => {
  const tablist = html.match(/<div id="tabs"[\s\S]*?<\/div>/)?.[0] || '';
  assert.match(tablist, /id="tabOverview"/);
  assert.match(tablist, /id="tabDetails"/);
  assert.doesNotMatch(html, /tabQuestions|questionsPanel"[^>]*role="tabpanel"/);
  assert.equal((tablist.match(/role="tab"/g) || []).length, 2);
  assert.match(css, /\.tabs\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('Step 3 remains disabled until usable questions are present and guards activation', () => {
  assert.match(html, /id="stepQuestions" disabled aria-describedby="questionsStepHelp"/);
  assert.match(app, /\$\('stepQuestions'\)\.disabled = !state\.questions\.length/);
  assert.match(app, /if \(!state\.questions\.length \|\| \$\('stepQuestions'\)\.disabled\) return/);
  assert.match(app, /const questions = records\(data\.questions\)\.filter\(q => text\(q\.question\)\.trim\(\)\)/);
  assert.match(css, /\.workflow button:disabled/);
});

test('question preparation action exists only in Overview and calls the existing request once per activation', () => {
  assert.match(html, /id="prepareQuestions"[^>]*>Prepare interview questions<\/button>/);
  assert.doesNotMatch(html, /generateQuestionsBtn/);
  assert.match(app, /\$\('prepareQuestions'\)\.addEventListener\('click', async \(\) => \{/);
  assert.match(app, /if \(!state\.current \|\| state\.questionBusy/);
  assert.equal((app.match(/fetch\(`\/api\/resume\/\$\{encodeURIComponent\(resumeId\)\}\/questions`/g) || []).length, 1);
  assert.match(app, /\$\('prepareQuestions'\)\.disabled = !state\.current \|\| state\.uploadBusy \|\| state\.questionBusy/);
});

test('Back to Overview selects the existing Overview tab without changing analysis state', () => {
  assert.match(html, /id="backToOverview"[^>]*>Back to Overview<\/button>/);
  assert.match(app, /\$\('backToOverview'\)\.addEventListener\('click', \(\) => \{ selectTab\(0\); \$\('tabOverview'\)\.focus\(\); \}\)/);
});

test('successful fallback or generated questions use the existing usable-results gate', () => {
  assert.match(app, /if \(!questions\.length\) \{[\s\S]*?Retry question preparation/);
  assert.match(app, /state\.questions = questions[\s\S]*?setStep\(2\)/);
  assert.match(app, /\$\('questionsStepHelp'\)\.hidden = Boolean\(state\.questions\.length\)/);
  assert.match(app, /if \(state\.questions\.length\) \$\('stepQuestions'\)\.removeAttribute\('aria-describedby'\)/);
  assert.doesNotMatch(app, /questionsStepHelp'\)\.textContent = state\.questions\.length \? 'Questions are ready'/);
});
