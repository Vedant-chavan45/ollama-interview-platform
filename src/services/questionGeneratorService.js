/**
 * questionGeneratorService.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * IMPORTANT — architecture note: on the team's module dependency slide,
 * "personalised question generation" belongs to the Interview module
 * (Modules 1/3), not Module 4. Module 4's real job ends at producing the
 * ResumeContext object (see contextBuilder.js) and handing it off.
 *
 * This service exists so the DEMO can show the whole flow end-to-end —
 * "here's what a real interview question generated from this exact resume
 * looks like" — without overclaiming Module 4's actual scope. It consumes
 * a ResumeContext exactly the way the Interview module would, and nothing
 * about it requires touching resumeParserService/pdfService/ollamaService
 * again. Mention this boundary explicitly if a mentor asks who "owns"
 * question generation.
 *
 * Same reliability pattern as ollamaService.js: try a local Llama 3.2 call
 * first, fall back to deterministic heuristic questions built straight
 * from the ResumeContext if Ollama is unavailable — never throws, always
 * labels which one ran via `source`.
 * -----------------------------------------------------------------------
 */

const axios = require('axios');
const { StringDecoder } = require('node:string_decoder');
const interviewPlannerService = require('./interviewPlannerService');
const { validateGeneratedQuestions } = require('./questionValidatorService');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const TOTAL_TIMEOUT_MS = positiveInteger(process.env.QUESTION_GENERATION_TIMEOUT_MS, 90000);
const REQUEST_TIMEOUT_MS = positiveInteger(process.env.OLLAMA_TIMEOUT_MS, 90000);
// Six short questions plus JSON structure usually fit comfortably in this budget.
const NUM_PREDICT = positiveInteger(process.env.QUESTION_GENERATION_NUM_PREDICT, 300);
const NUM_CTX = positiveInteger(process.env.QUESTION_GENERATION_NUM_CTX, 4096);
const RETRY_MIN_REMAINING_MS = 15000;
// Keep the constrained grammar small. Length limits are enforced in our validator,
// not in the model's decoding grammar, which can be expensive on small local models.
// Type labels are assigned by the application from the required slot order.
const QUESTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', minItems: 6, maxItems: 6, items: { type: 'string' } },
  },
  required: ['questions'], additionalProperties: false,
};

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function generate(prompt, timeout, onFirstChunk) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  let response;
  let buffer = '';
  let reply = '';
  let done = false;
  let doneReason;
  let evalCount;
  let promptEvalCount;
  let firstChunk = true;
  const decoder = new StringDecoder('utf8');

  const collectRecord = (record) => {
    if (typeof record.response === 'string') reply += record.response;
    if (record.done === true) {
      done = true;
      if (typeof record.done_reason === 'string') doneReason = record.done_reason;
      if (Number.isSafeInteger(record.eval_count)) evalCount = record.eval_count;
      if (Number.isSafeInteger(record.prompt_eval_count)) promptEvalCount = record.prompt_eval_count;
    }
  };

  try {
    response = await axios.post(
      `${OLLAMA_BASE_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: true,
        format: QUESTION_RESPONSE_SCHEMA,
        keep_alive: '10m',
        options: { num_predict: NUM_PREDICT, num_ctx: NUM_CTX, temperature: 0.2 },
      },
      { timeout, signal: controller.signal, responseType: 'stream' }
    );

    if (response.data && typeof response.data[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.data) {
        if (firstChunk) {
          firstChunk = false;
          onFirstChunk?.();
        }
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          collectRecord(JSON.parse(line));
        }
        if (done) break;
      }
      buffer += decoder.end();
      if (buffer.trim()) collectRecord(JSON.parse(buffer));
    } else if (typeof response.data?.response === 'string') {
      // Tolerate buffered adapters in unit tests and compatible proxies.
      reply = response.data.response;
      done = response.data.done !== false;
      doneReason = response.data.done_reason;
      evalCount = response.data.eval_count;
      promptEvalCount = response.data.prompt_eval_count;
    }

    return { reply, status: response.status, done, doneReason, evalCount, promptEvalCount };
  } catch (err) {
    if (timedOut) {
      const timeoutError = new Error('Ollama request timed out.');
      timeoutError.code = 'ECONNABORTED';
      throw timeoutError;
    }
    if (err instanceof SyntaxError) {
      const responseError = new Error('Ollama returned an invalid stream record.');
      responseError.code = 'OLLAMA_INVALID_RESPONSE';
      responseError.status = response?.status;
      throw responseError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(reply) {
  try {
    return JSON.parse(reply);
  } catch (err) {
    const stripped = reply.replace(/```json|```/g, '').trim();
    return JSON.parse(stripped);
  }
}

function expectedQuestionTypes(resumeContext) {
  const c = candidateData(resumeContext);
  const hasProjects = c.projects.length > 0;
  const hasExperience = c.experience.length > 0 || !!c.experienceSummary;
  const counts = {
    technical: 6 - (hasProjects ? 2 : 0) - (hasExperience ? 1 : 0) - 1,
    project: hasProjects ? 2 : 0,
    experience: hasExperience ? 1 : 0,
    behavioral: 1,
  };
  return Object.entries(counts).flatMap(([type, count]) => Array(count).fill(type));
}

async function generateJsonWithRetry(prompt, role, validate) {
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const remaining = deadline - Date.now();
    try {
      const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining));
      const requestStartedAt = Date.now();
      debugGeneration({ stage: 'request-start', role, startedAt, attempt, timeoutMs,
        promptChars: prompt.length, category: 'pending' });
      let response;
      try {
        response = await generate(prompt, timeoutMs, () => debugGeneration({ stage: 'first-chunk', role, startedAt,
          attempt, durationMs: Date.now() - requestStartedAt, timeoutMs, category: 'streaming' }));
        debugGeneration({ stage: 'request-complete', role, startedAt, attempt,
          durationMs: Date.now() - requestStartedAt, timeoutMs, status: response.status,
          evalTokens: response.evalCount, promptEvalTokens: response.promptEvalCount,
          doneReason: response.doneReason, responseChars: response.reply.length, category: 'ok' });
      } catch (err) {
        debugGeneration({ stage: 'request-failed', role, startedAt, attempt,
          durationMs: Date.now() - requestStartedAt, timeoutMs, ...safeRequestDetails(err),
          category: questionGenerationErrorCategory(err) });
        throw err;
      }
      if (!response.done || typeof response.reply !== 'string' || !response.reply.trim()) {
        const error = new Error('Ollama response did not contain generated text.');
        error.code = 'OLLAMA_INVALID_RESPONSE';
        error.status = response.status;
        throw error;
      }
      let parsed;
      try {
        parsed = parseJson(response.reply);
      } catch (err) {
        debugGeneration({ stage: 'json-parse-failed', role, startedAt, attempt,
        durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status,
          category: 'json-parse-error' });
        throw err;
      }
      debugGeneration({ stage: 'validation-pending', role, startedAt, attempt,
        durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status, category: 'json-ok' });
      try {
        const validated = validate(parsed);
        debugGeneration({ stage: 'validation-complete', role, startedAt, attempt,
          durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status, category: 'valid' });
        return validated;
      } catch (err) {
        debugGeneration({ stage: 'validation-failed', role, startedAt, attempt,
          durationMs: Date.now() - requestStartedAt, timeoutMs, httpStatus: response.status,
          category: questionGenerationDiagnostic(err) });
        throw err;
      }
    } catch (err) {
      const category = questionGenerationErrorCategory(err);
      // Retry only a complete response that is malformed JSON. Request failures,
      // timeout errors, and semantic validation failures go directly to fallback.
      const retryable = category === 'json-parse-error';
      const remainingMs = deadline - Date.now();
      if (!retryable || attempt >= 2 || remainingMs < RETRY_MIN_REMAINING_MS) throw err;
    }
  }
  const error = new Error('Question generation deadline exceeded.');
  error.code = 'QUESTION_GENERATION_TIMEOUT';
  throw error;
}

function safeRequestDetails(err) {
  const codes = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND',
    'EAI_AGAIN', 'ERR_NETWORK', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_CANCELED', 'EHOSTUNREACH', 'ENETUNREACH']);
  const details = {};
  if (codes.has(err.code)) details.errorCode = err.code;
  const status = err.response?.status ?? err.status;
  if (Number.isInteger(status) && status >= 100 && status <= 599) details.httpStatus = status;
  return details;
}

function debugGeneration({ stage, role, startedAt, attempt, durationMs, timeoutMs, promptChars, status, httpStatus, errorCode, evalTokens, promptEvalTokens, doneReason, responseChars, category }) {
  if (process.env.DEBUG_QUESTION_GENERATION === '1') {
    const safeRole = typeof role === 'string' ? role.replace(/[^\w .+/-]/g, '').slice(0, 60) || 'unknown' : 'unknown';
    const details = [`stage=${stage}`, `role=${safeRole}`, `elapsedMs=${Date.now() - startedAt}`,
      `attempt=${attempt}`, `category=${category}`];
    if (Number.isSafeInteger(durationMs)) details.push(`requestMs=${durationMs}`);
    if (Number.isSafeInteger(timeoutMs)) details.push(`timeoutMs=${timeoutMs}`);
    if (Number.isSafeInteger(promptChars)) details.push(`promptChars=${promptChars}`);
    if (Number.isSafeInteger(responseChars)) details.push(`responseChars=${responseChars}`);
    if (Number.isSafeInteger(evalTokens)) details.push(`evalTokens=${evalTokens}`);
    if (Number.isSafeInteger(promptEvalTokens)) details.push(`promptEvalTokens=${promptEvalTokens}`);
    if (typeof doneReason === 'string' && /^[a-z_ -]{1,30}$/i.test(doneReason)) details.push(`doneReason=${doneReason.replace(/\s+/g, '_')}`);
    if (Number.isInteger(status ?? httpStatus)) details.push(`httpStatus=${status ?? httpStatus}`);
    if (errorCode) details.push(`errorCode=${errorCode}`);
    console.error(`[questionGeneratorService] ${details.join(' ')}`);
  }
}

// Normalize only the context consumed here; legacy documents need no migration.
const text = (value) => typeof value === 'string' ? value.trim() : '';
const list = (value) => Array.isArray(value) ? value : [];
const strings = (value) => list(value).map(text).filter(Boolean);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function candidateData(context) {
  const c = object(context);
  return {
    targetRole: text(c.targetRole) || 'Software Engineer',
    interviewType: text(c.interviewType) || 'Technical',
    candidateSummary: text(c.candidateSummary),
    strengths: strings(c.strengths),
    skillAreasToProbe: strings(c.skillAreasToProbe),
    skills: strings(c.skills),
    projects: list(c.projects).map((value) => {
      const p = object(value);
      return { title: text(p.title), technologies: strings(p.technologies), description: text(p.description) };
    }).filter((p) => p.title || p.description || p.technologies.length),
    experience: list(c.experience).map((value) => {
      const e = object(value);
      return { role: text(e.role), organisation: text(e.organisation), duration: text(e.duration),
        responsibilities: strings(e.responsibilities) };
    }).filter((e) => e.role || e.organisation || e.duration || e.responsibilities.length),
    experienceSummary: text(c.experienceSummary),
    education: list(c.education).map((value) => {
      const e = object(value);
      return [text(e.degree), text(e.institution), text(e.year)].filter(Boolean).join(', ');
    }).filter(Boolean),
  };
}

function buildQuestionPrompt(resumeContext, interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext)) {
  const c = candidateData(resumeContext);
  const orderedTypes = expectedQuestionTypes(resumeContext);
  const slotRequirements = orderedTypes.map((type, index) => `${index + 1}. ${type}`).join('\n');
  const compactProjects = c.projects.slice(0, 3).map((p) => ({
    title: p.title,
    technologies: p.technologies.slice(0, 4),
    details: p.description.slice(0, 105),
  }));
  const compactExperience = c.experience.slice(0, 2).map((e) => ({
    role: e.role,
    organisation: e.organisation,
    duration: e.duration,
    responsibilities: e.responsibilities.slice(0, 2).map((r) => r.slice(0, 75)),
  }));
  const focus = interviewPlan.focusAreas.slice(0, 5).map((area) => ({ topic: area.topic, priority: area.priority }));

  return `Generate exactly six distinct interview questions for ${c.targetRole} (${c.interviewType}).
Return only this JSON object: {"questions":["question 1?","question 2?","question 3?","question 4?","question 5?","question 6?"]}.
The questions array must contain six strings only. Do not return objects, type labels, evidence anchors, markdown, or other fields. The application assigns question types and evidence anchors from the numbered slots and structured resume.
Required slot types in this exact order:
${slotRequirements}
Every question must be one concise sentence, at most 180 characters, and end with a question mark. Technical slots should test applied reasoning about the highest-priority role topics. Project slots should ask about the candidate's actual listed projects. The experience slot should ask about a real challenge and how a fix was verified. The behavioral slot should address feedback, disagreement, communication, or learning.
Use only concrete resume facts for candidate-specific claims; ask role-relevant questions without claiming candidate experience not shown. Prefer projects relevant to the target role. Do not ask standalone definitions or repeat questions in different words.
PLAN ${JSON.stringify({ domain: interviewPlan.primaryDomain, profile: interviewPlan.roleProfile, focus })}
RESUME ${JSON.stringify({ interviewType: c.interviewType, targetRole: c.targetRole,
    skills: c.skills.slice(0, 12), projects: compactProjects, experience: compactExperience,
    experienceSummary: compactExperience.length ? undefined : c.experienceSummary.slice(0, 120), education: c.education.slice(0, 2) })}`;
}

/** Deterministic six-question fallback, grounded only in structured evidence. */
function heuristicFallbackQuestions(resumeContext, interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext)) {
  const c = candidateData(resumeContext);
  const questions = [];
  const add = (question, type, basedOn) => questions.push({ question, type, basedOn });
  const shorten = (value, max = 80) => {
    const cleaned = text(value).replace(/\s+/g, ' ');
    if (cleaned.length <= max) return cleaned;
    const cut = cleaned.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  };
  const projectEvidence = (p) => {
    const title = p.title ? `project "${shorten(p.title, 65)}"` : 'the listed project';
    const stack = p.technologies.length ? ` (${p.technologies.slice(0, 3).map((v) => shorten(v, 22)).join(', ')})` : '';
    return `${title}${stack}`;
  };
  const role = c.targetRole;
  const areas = interviewPlan.focusAreas;
  const supportedAreas = areas.filter((area) => area.evidence.length);
  const technicalAreas = supportedAreas.length ? supportedAreas : areas;
  const projectMatches = (p, area) => [p.title, p.description, ...p.technologies]
    .some((claim) => claim && area.evidence.includes(claim));
  const projectRank = (p) => {
    const index = areas.findIndex((area) => projectMatches(p, area));
    return index < 0 ? areas.length : index;
  };
  c.projects.sort((a, b) => projectRank(a) - projectRank(b));
  const usedSkills = new Set();

  for (let i = 0; i < 2; i += 1) {
    const area = technicalAreas[i % Math.max(technicalAreas.length, 1)];
    const candidates = [
      ...c.projects.flatMap((project) => project.technologies), ...c.skills, ...area.evidence,
    ].filter((claim) => area.evidence.includes(claim) && (!usedSkills.has(claim) ||
      (interviewPlan.roleProfile === 'systems' && area.topic === 'Programming Fundamentals & OOP')));
    const claim = area
      ? interviewPlannerService.rankFocusEvidence(area.topic, candidates, interviewPlan.roleProfile)[0]
      : undefined;
    if (claim) usedSkills.add(claim);
    const project = claim && c.projects.find((p) => p.title === claim || p.description === claim || p.technologies.includes(claim));
    const anchor = project?.title || claim || area?.topic || role;
    const topic = area?.topic || 'technical problem solving';
    add(i === 0
      ? `For a ${shorten(role, 35)} role, how would you approach ${shorten(topic, 40)} using ${shorten(anchor, 45)}? What trade-off would you consider?`
      : `How would you investigate a ${shorten(topic, 42)} problem involving ${shorten(anchor, 45)}, and what evidence would confirm the fix?`,
    'technical', shorten(anchor, 80));
  }

  for (let i = 0; i < 2; i += 1) {
    const project = c.projects[i % (c.projects.length || 1)];
    if (project) {
      const evidence = projectEvidence(project);
      add(i === 0
        ? `In ${evidence}, what was your contribution to an important design decision, and why did you choose that approach?`
        : `How would you test ${evidence} for failure cases and limitations relevant to a ${shorten(role, 35)} role?`,
      'project', shorten(project.title || project.description || project.technologies.join(', '), 80));
    } else {
      const anchor = c.skills[i] || c.education[i] || c.education[0] || role;
      add(i === 0
        ? `How would you apply ${shorten(anchor, 55)} to solve a realistic problem for a ${shorten(role, 35)} role?`
        : `How would you test a solution involving ${shorten(anchor, 55)} and identify its limitations?`,
      'technical', shorten(anchor, 80));
    }
  }

  const experience = c.experience[0];
  const legacy = c.experienceSummary.split(';')[0].trim();
  if (experience || legacy) {
    const label = experience
      ? [experience.role, experience.organisation].filter(Boolean).join(' at ')
      : legacy;
    const responsibility = experience?.responsibilities[0];
    add(`At ${shorten(label || 'your listed experience', 65)}, describe a challenge${responsibility ? ` involving ${shorten(responsibility, 65)}` : ''}; how did you investigate it and verify the fix?`,
      'experience', shorten(experience?.role || experience?.organisation || legacy || 'listed experience', 80));
  } else {
    const anchor = c.projects[0]?.title || c.skills[0] || c.education[0] || role;
    add(`Describe a work or study challenge related to ${shorten(anchor, 55)}. How did you communicate, handle feedback, and decide what to improve?`,
      'technical', shorten(anchor, 80));
  }

  const behavioralAnchor = c.projects[0]?.title || experience?.role || legacy || c.education[0];
  add(`Describe a time you handled feedback or disagreement${behavioralAnchor ? `, drawing on ${shorten(behavioralAnchor, 55)} if relevant` : ''}. How did you communicate and what did you learn?`,
    'behavioral', shorten(behavioralAnchor || 'general', 80));
  return { questions, source: 'heuristic-fallback' };
}

function shortenAnchor(value, maxLength = 80) {
  const clean = text(value).replace(/\s+/g, ' ');
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function structuredAnchors(c) {
  return [...c.skills,
    ...c.projects.flatMap((p) => [p.title, ...p.technologies, p.description]),
    ...c.experience.flatMap((e) => [e.role, e.organisation, e.duration, ...e.responsibilities]),
    ...c.education, c.experienceSummary]
    .map((value) => text(value).replace(/\s+/g, ' ')).filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function chooseQuestionAnchor(type, slotIndex, types, c, resumeContext, interviewPlan, usedTechnicalAnchors) {
  const claims = structuredAnchors(c);
  if (type === 'behavioral') {
    return shortenAnchor(c.projects[0]?.title || c.experience[0]?.role || c.education[0] || 'general');
  }
  if (type === 'project') {
    const projectOrdinal = types.slice(0, slotIndex + 1).filter((item) => item === 'project').length - 1;
    const projectMatches = (project, area) => [project.title, project.description, ...project.technologies]
      .some((claim) => claim && area.evidence.includes(claim));
    const score = (project) => {
      const index = interviewPlan.focusAreas.findIndex((area) => projectMatches(project, area));
      return index < 0 ? interviewPlan.focusAreas.length : index;
    };
    const projects = c.projects.slice().sort((a, b) => score(a) - score(b));
    const project = projects[projectOrdinal % Math.max(projects.length, 1)];
    return shortenAnchor(project?.title || project?.technologies[0] || project?.description || claims[0] || text(object(resumeContext).targetRole));
  }
  if (type === 'experience') {
    const experience = c.experience[0];
    return shortenAnchor(experience?.role || experience?.organisation || experience?.responsibilities[0] ||
      c.experienceSummary || claims[0] || text(object(resumeContext).targetRole));
  }

  const technicalOrdinal = types.slice(0, slotIndex).filter((item) => item === 'technical').length;
  const supportedAreas = interviewPlan.focusAreas.filter((area) => Array.isArray(area.evidence) && area.evidence.length);
  const area = supportedAreas[technicalOrdinal % Math.max(supportedAreas.length, 1)];
  const candidates = area ? claims.filter((claim) => area.evidence.includes(claim)) : claims;
  const ranked = area
    ? interviewPlannerService.rankFocusEvidence(area.topic, candidates, interviewPlan.roleProfile)
    : candidates;
  const selected = ranked.find((claim) => !usedTechnicalAnchors.has(claim)) || ranked[0] ||
    claims.find((claim) => !usedTechnicalAnchors.has(claim)) || claims[0] || text(object(resumeContext).targetRole);
  if (selected) usedTechnicalAnchors.add(selected);
  return shortenAnchor(selected || '');
}

function applyPlannedMetadata(result, resumeContext, interviewPlan) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Reflect.ownKeys(result).length !== 1 || !Object.hasOwn(result, 'questions') || !Array.isArray(result.questions)) return result;
  const questionCount = result.questions.length;
  const invalidIndex = result.questions.findIndex((item) => typeof item !== 'string');
  if (invalidIndex >= 0) {
    const error = new Error('Invalid generated questions.');
    error.code = 'invalid-item-shape';
    error.questionCount = questionCount;
    error.questionIndex = invalidIndex;
    throw error;
  }
  const types = expectedQuestionTypes(resumeContext);
  const c = candidateData(resumeContext);
  const usedTechnicalAnchors = new Set();
  return { questions: result.questions.map((question, index) => ({
    question,
    type: types[index],
    basedOn: chooseQuestionAnchor(types[index], index, types, c, resumeContext, interviewPlan, usedTechnicalAnchors),
  })) };
}

function questionGenerationErrorCategory(err) {
  if (err?.code === 'OLLAMA_INVALID_RESPONSE') return 'ollama-response-error';
  if (axios.isAxiosError(err) || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
    'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK', 'ERR_CANCELED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(err?.code)) {
    return 'ollama-request-error';
  }
  if (err instanceof SyntaxError) return 'json-parse-error';
  if (err instanceof Error && err.message === 'Invalid generated questions.') return 'question-validation-error';
  return 'question-generation-error';
}

function questionGenerationDiagnostic(err) {
  const category = questionGenerationErrorCategory(err);
  const parts = [category];
  if (category === 'question-validation-error') {
    const reasons = new Set(['invalid-envelope', 'wrong-question-count', 'invalid-item-shape', 'invalid-type',
      'empty-or-oversized-field', 'duplicate-question', 'generic-definition', 'invalid-grounding', 'invalid-distribution']);
    if (reasons.has(err.code)) parts.push(`reason=${err.code}`);
    if (Number.isSafeInteger(err.questionIndex) && err.questionIndex >= 0) parts.push(`questionIndex=${err.questionIndex}`);
    if (Number.isSafeInteger(err.questionCount) && err.questionCount >= 0) parts.push(`questionCount=${err.questionCount}`);
    if (err.code === 'invalid-distribution' && err.actualTypeCounts && err.expectedTypeCounts) {
      const formatCounts = (counts) => ['technical', 'project', 'experience', 'behavioral']
        .map((type) => `${type}:${counts[type]}`).join(',');
      parts.push(`actual={${formatCounts(err.actualTypeCounts)}}`);
      parts.push(`expected={${formatCounts(err.expectedTypeCounts)}}`);
    }
  }
  return parts.join(' ');
}

async function generateQuestions(resumeContext) {
  const startedAt = Date.now();
  const interviewPlan = interviewPlannerService.buildInterviewPlan(resumeContext);
  const role = candidateData(resumeContext).targetRole;
  try {
    const prompt = buildQuestionPrompt(resumeContext, interviewPlan);
    const questions = await generateJsonWithRetry(prompt, role,
      (result) => validateGeneratedQuestions(applyPlannedMetadata(result, resumeContext, interviewPlan), resumeContext, interviewPlan));
    return { questions, source: 'ollama-llama3.2' };
  } catch (err) {
    debugGeneration({ stage: 'fallback-selected', role, startedAt, attempt: 0,
      ...safeRequestDetails(err), category: questionGenerationDiagnostic(err) });
    return heuristicFallbackQuestions(resumeContext, interviewPlan);
  }
}

module.exports = { generateQuestions, heuristicFallbackQuestions, buildQuestionPrompt };
