/** Pure AI-output validation. Throws internally; callers return their existing fallback. */
const MAX_QUESTION_LENGTH = 240;
const MAX_BASED_ON_LENGTH = 120;
const TYPES = new Set(['technical', 'project', 'behavioral', 'experience']);
const text = (v) => typeof v === 'string' ? v.trim() : '';
const list = (v) => Array.isArray(v) ? v : [];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const plain = (v) => v !== null && typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const words = (v) => (text(v).toLowerCase().match(/[\p{L}\p{N}]+(?:[.+#]+[\p{L}\p{N}]*)*/gu) || [])
  .map((token) => token.replace(/\.+$/, ''));
const connectors = new Set(['the', 'a', 'an', 'and', 'or', 'at', 'in', 'of', 'for', 'with',
  'project', 'projects', 'experience', 'role', 'skill', 'skills']);
const duplicateKey = (v) => v.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.!?,;:]+$/, '').trim();

function fail(code, questionCount, questionIndex, safeDetails = {}) {
  const error = new Error('Invalid generated questions.');
  error.code = code;
  if (Number.isSafeInteger(questionCount) && questionCount >= 0) error.questionCount = questionCount;
  if (Number.isSafeInteger(questionIndex) && questionIndex >= 0) error.questionIndex = questionIndex; // zero-based
  if (safeDetails.actualTypeCounts) error.actualTypeCounts = safeDetails.actualTypeCounts;
  if (safeDetails.expectedTypeCounts) error.expectedTypeCounts = safeDetails.expectedTypeCounts;
  throw error;
}

function groundingData(resumeContext, interviewPlan) {
  const c = object(resumeContext);
  const anchors = [];
  const add = (v) => { if (text(v)) anchors.push(text(v)); };
  list(c.skills).forEach(add);
  add(c.targetRole);
  const projects = list(c.projects).map(object).filter((p) =>
    text(p.title) || text(p.description) || list(p.technologies).some(text));
  projects.forEach((p) => { add(p.title); add(p.description); list(p.technologies).forEach(add); });
  const experience = list(c.experience).map(object).filter((e) =>
    text(e.role) || text(e.organisation) || text(e.duration) || list(e.responsibilities).some(text));
  experience.forEach((e) => {
    add(e.role); add(e.organisation); add(e.duration); list(e.responsibilities).forEach(add);
  });
  add(c.experienceSummary);
  list(c.education).forEach((value) => {
    const e = object(value); add(e.degree); add(e.institution); add(e.year);
  });
  list(object(interviewPlan).focusAreas).forEach((value) => {
    const area = object(value); add(area.topic); list(area.evidence).forEach(add);
  });
  return { tokens: new Set(anchors.flatMap(words)), hasProjects: projects.length > 0,
    hasExperience: experience.length > 0 || !!text(c.experienceSummary) };
}

function isDefinition(question) {
  // Only short, standalone definition requests without personal/application context.
  const q = question.replace(/\s+/g, ' ').trim();
  return /^(?:what (?:is|are)|define)\s+[^?!;]+[?.!]*$/i.test(q) &&
    words(q).length <= 12 &&
    !/\b(you|your|our|how|why|when|where|in|for|during|would|could|should)\b/i.test(q);
}

function validateGeneratedQuestions(result, resumeContext, interviewPlan) {
  const questionCount = Array.isArray(result?.questions) ? result.questions.length : undefined;
  if (!plain(result) || Reflect.ownKeys(result).length !== 1 ||
      !Object.hasOwn(result, 'questions') || !Array.isArray(result.questions)) fail('invalid-envelope', questionCount);
  if (questionCount !== 6) fail('wrong-question-count', questionCount);
  const grounding = groundingData(resumeContext, interviewPlan);
  const seen = new Set();
  const counts = { technical: 0, project: 0, behavioral: 0, experience: 0 };
  const questions = [];
  for (const [questionIndex, item] of result.questions.entries()) {
    if (!plain(item) || Reflect.ownKeys(item).length !== 3 ||
        !['question', 'type', 'basedOn'].every((key) => Object.hasOwn(item, key) && typeof item[key] === 'string')) fail('invalid-item-shape', questionCount, questionIndex);
    const question = item.question.trim();
    const type = item.type.trim();
    const basedOn = item.basedOn.trim();
    if (!question || question.length > MAX_QUESTION_LENGTH || !basedOn ||
        basedOn.length > MAX_BASED_ON_LENGTH) fail('empty-or-oversized-field', questionCount, questionIndex);
    if (!TYPES.has(type)) fail('invalid-type', questionCount, questionIndex);
    const key = duplicateKey(question);
    if (!key || seen.has(key)) fail('duplicate-question', questionCount, questionIndex);
    if (isDefinition(question)) fail('generic-definition', questionCount, questionIndex);
    seen.add(key);
    const tokens = words(basedOn).filter((token) => !connectors.has(token));
    const general = type === 'behavioral' && basedOn.toLowerCase() === 'general';
    // Whole tokens allow combined anchors while rejecting unsupported additions and substrings.
    if (!general && (!tokens.length || !tokens.every((token) => grounding.tokens.has(token)))) fail('invalid-grounding', questionCount, questionIndex);
    counts[type] += 1;
    questions.push({ question, type, basedOn });
  }
  const expectedTypeCounts = {
    technical: 6 - (grounding.hasProjects ? 2 : 0) - (grounding.hasExperience ? 1 : 0) - 1,
    project: grounding.hasProjects ? 2 : 0,
    experience: grounding.hasExperience ? 1 : 0,
    behavioral: 1,
  };
  if (counts.behavioral !== 1 || counts.technical < 2 ||
      (grounding.hasProjects ? counts.project < 2 : counts.project !== 0) ||
      counts.experience !== (grounding.hasExperience ? 1 : 0)) {
    fail('invalid-distribution', questionCount, undefined, {
      actualTypeCounts: counts, expectedTypeCounts,
    });
  }
  return questions;
}

module.exports = { validateGeneratedQuestions };
