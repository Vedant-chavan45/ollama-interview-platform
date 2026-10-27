'use strict';

const QUESTION_COUNT_PER_CATEGORY = 6;

const categories = Object.freeze({
  domain_fundamentals: Object.freeze({
    id: 'domain_fundamentals', label: 'Role & Domain Fundamentals',
    description: 'Explore core principles and trade-offs that shape the target role and its technical domain.',
    legacyType: 'technical',
    instruction: 'Test role-specific fundamentals and reasoning about why core design principles matter; do not ask for a glossary definition.',
    relevance: /\b(approach\w*|appl\w*|design\w*|trade.?offs?|principle\w*|fundamental\w*|reason\w*|choos\w*|why|how would)\b/i,
  }),
  technical_concepts: Object.freeze({
    id: 'technical_concepts', label: 'Technical Skills & Concepts',
    description: 'Assess practical understanding of the skills and technologies evidenced in the resume.',
    legacyType: 'technical',
    instruction: 'Ask practical implementation, debugging, testing, integration, security or optimization questions about listed skills; avoid standalone definitions.',
    relevance: /\b(implement|debug|test|integrat|secure|optimi[sz]|configure|design|trace|query|how would)\b/i,
  }),
  project_deep_dive: Object.freeze({
    id: 'project_deep_dive', label: 'Project Deep Dive',
    description: 'Probe real project decisions, individual contributions, constraints and verification.',
    legacyType: 'project',
    instruction: 'Ask about the candidate’s actual listed project: contribution, a specific design decision, constraints, failure cases, or how results were verified.',
    relevance: /\b(project|built|developed|implement\w*|contribution|decision|constraint|architecture|verified|trade.?offs?|design\w*|redesign|test)\b/i,
  }),
  professional_experience: Object.freeze({
    id: 'professional_experience', label: 'Professional Experience',
    description: 'Discuss responsibilities, delivery, challenges and outcomes from the experience listed in the resume.',
    legacyType: 'experience',
    instruction: 'Ask about real roles, responsibilities, delivery, challenges and evidence of impact; do not invent employers or achievements.',
    relevance: /\b(experience|role|responsibilit\w*|challenge|contribution|work|intern|deliver\w*|decis\w*|impact|colleague|team)\b/i,
  }),
  applied_scenarios: Object.freeze({
    id: 'applied_scenarios', label: 'Applied Technical Scenarios',
    description: 'Work through realistic hypothetical technical problems using relevant skills from the resume.',
    legacyType: 'technical',
    instruction: 'Present applied hypothetical situations, incidents or constraints and ask for a solution and trade-off; never ask generic definitions.',
    relevance: /\b(if|suppose|scenario|imagine|imagin(?:e|ing)|given|incident|situation|what would you do)\b/i,
  }),
  behavioral_collaboration: Object.freeze({
    id: 'behavioral_collaboration', label: 'Behavioral & Collaboration',
    description: 'Explore communication, collaboration, feedback, ownership and learning grounded in real experience.',
    legacyType: 'behavioral',
    instruction: 'Ask behavioral questions about communication, collaboration, feedback, disagreement, ownership or learning, grounded in real resume evidence where possible.',
    relevance: /\b(communicat\w*|collaborat\w*|team|feedback|disagree\w*|conflict\w*|ownership|learn\w*|support|stakeholder\w*)\b/i,
  }),
});

function getQuestionCategory(id) {
  return typeof id === 'string' && Object.hasOwn(categories, id) ? categories[id] : null;
}

module.exports = { QUESTION_COUNT_PER_CATEGORY, QUESTION_CATEGORIES: categories, getQuestionCategory };
