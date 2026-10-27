/** Pure AI-output validation. Throws internally; callers return their existing fallback. */
const MAX_QUESTION_LENGTH = 240;
const MAX_BASED_ON_LENGTH = 120;
const TYPES = new Set(['technical', 'project', 'behavioral', 'experience']);
const { QUESTION_COUNT_PER_CATEGORY } = require('./questionCategories');
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
const shortAnchor = (value) => {
  const anchor = text(value).replace(/\s+/g, ' ');
  if (anchor.length <= MAX_BASED_ON_LENGTH) return anchor;
  const cut = anchor.slice(0, MAX_BASED_ON_LENGTH - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > MAX_BASED_ON_LENGTH * 0.6 ? cut.slice(0, boundary) : cut).trim()}…`;
};

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

function validateGeneratedQuestions(result, resumeContext, interviewPlan, options = {}) {
  const questionCount = Array.isArray(result?.questions) ? result.questions.length : undefined;
  if (!plain(result) || Reflect.ownKeys(result).length !== 1 ||
      !Object.hasOwn(result, 'questions') || !Array.isArray(result.questions)) fail('invalid-envelope', questionCount);
  if (questionCount !== (options.questionCount || 6)) fail('wrong-question-count', questionCount);
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
  if (!options.skipDistribution && (counts.behavioral !== 1 || counts.technical < 2 ||
      (grounding.hasProjects ? counts.project < 2 : counts.project !== 0) ||
      counts.experience !== (grounding.hasExperience ? 1 : 0))) {
    fail('invalid-distribution', questionCount, undefined, {
      actualTypeCounts: counts, expectedTypeCounts,
    });
  }
  return questions;
}

function validateGeneratedCategoryQuestions(result, resumeContext, interviewPlan, category) {
  const questionCount = Array.isArray(result?.questions) ? result.questions.length : undefined;
  if (!plain(result) || Reflect.ownKeys(result).length !== 1 ||
      !Object.hasOwn(result, 'questions') || !Array.isArray(result.questions)) fail('invalid-envelope', questionCount);
  if (questionCount !== QUESTION_COUNT_PER_CATEGORY) fail('wrong-question-count', questionCount);
  const c = object(resumeContext);
  const skills = list(c.skills).map(text).filter(Boolean);
  const projects = list(c.projects).map(object);
  const experience = list(c.experience).map(object);
  const education = list(c.education).map(object);
  const focusAreas = list(interviewPlan?.focusAreas);
  projects.sort((left, right) => {
    const relevance = (project) => {
      const index = focusAreas.findIndex((area) => [text(project.title), text(project.description), ...list(project.technologies).map(text)]
        .some((claim) => claim && list(object(area).evidence).map(text).includes(claim)));
      return index < 0 ? focusAreas.length : index;
    };
    return relevance(left) - relevance(right);
  });
  const allAnchors = [...skills,
    ...projects.flatMap((p) => [text(p.title), ...list(p.technologies).map(text), text(p.description)]),
    ...experience.flatMap((e) => [text(e.role), text(e.organisation), ...list(e.responsibilities).map(text)]),
    ...education.flatMap((e) => [text(e.degree), text(e.institution)]), text(c.experienceSummary), text(c.targetRole)]
    .filter(Boolean);
  const categoryAnchors = category.id === 'project_deep_dive'
    ? [...projects.flatMap((p) => [text(p.title), ...list(p.technologies).map(text), text(p.description)]), ...skills]
    : category.id === 'professional_experience'
      ? [...experience.flatMap((e) => [text(e.role), text(e.organisation), ...list(e.responsibilities).map(text)]), text(c.experienceSummary), ...skills]
      : category.id === 'behavioral_collaboration'
        ? [...experience.flatMap((e) => [text(e.role), text(e.organisation), ...list(e.responsibilities).map(text)]), text(c.experienceSummary), ...projects.map((p) => text(p.title)), ...education.map((e) => text(e.degree))]
        : [...skills, ...list(interviewPlan?.focusAreas).flatMap((a) => list(object(a).evidence).map(text)), ...allAnchors];
  const anchor = shortAnchor(categoryAnchors.find(Boolean) || (category.legacyType === 'behavioral' ? 'general' : text(c.targetRole)));
  const hasProjects = projects.some((project) => text(project.title) || text(project.description) || list(project.technologies).some(text));
  const hasExperience = experience.length > 0 || Boolean(text(c.experienceSummary));
  const questions = result.questions.map((question, index) => {
    if (typeof question !== 'string') fail('invalid-item-shape', questionCount, index);
    if (!category.relevance.test(question)) fail('invalid-category-relevance', questionCount, index);
    if (category.id === 'project_deep_dive' && !hasProjects && !/\b(would|could|if|suppose|imagine|possible|building|build)\b/i.test(question)) {
      fail('invalid-category-relevance', questionCount, index);
    }
    if (category.id === 'professional_experience' && !hasExperience && !/\b(would|could|if|suppose|imagine|interest\w*)\b/i.test(question)) {
      fail('invalid-category-relevance', questionCount, index);
    }
    let basedOn = anchor;
    if (category.id === 'project_deep_dive') {
      const matchingProject = projects.map((project) => text(project.title)).filter(Boolean)
        .find((title) => question.toLowerCase().includes(shortAnchor(title).toLowerCase()));
      if (projects.some((project) => text(project.title)) && !matchingProject) fail('invalid-grounding', questionCount, index);
      if (matchingProject) basedOn = shortAnchor(matchingProject);
    }
    return { question, type: category.legacyType, basedOn };
  });
  return validateGeneratedQuestions({ questions }, resumeContext, interviewPlan,
    { skipDistribution: true, questionCount: QUESTION_COUNT_PER_CATEGORY });
}

module.exports = { validateGeneratedQuestions, validateGeneratedCategoryQuestions };
