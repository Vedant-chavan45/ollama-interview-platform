const mongoose = require('mongoose');
const Resume = require('../models/Resume');
const pdfService = require('../services/pdfService');
const resumeParserService = require('../services/resumeParserService');
const ollamaService = require('../services/ollamaService');
const contextBuilder = require('../services/contextBuilder');
const questionGeneratorService = require('../services/questionGeneratorService');

async function uploadResume(req, res) {
  try {
    if (!mongoose.isObjectIdOrHexString(req.user.id)) {
      return res.status(401).json({ error: 'Invalid user identity. Please log in again.' });
    }
    pdfService.validateFile(req.file);
    const { text, pageCount } = await pdfService.extractText(req.file.buffer);
    const parsedResume = resumeParserService.parse(text);
    const analysis = await ollamaService.analyseResume(parsedResume);
    const { interviewType, targetRole } = req.body;
    const resumeContext = contextBuilder.build(parsedResume, analysis, {
      interviewType,
      targetRole,
    });

    const resume = await Resume.create({
      userId: req.user.id,
      file: {
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
      },
      parsedResume,
      analysis,
      resumeContext,
      pageCount,
    });

    return res.status(201).json({
      resumeId: resume._id.toString(),
      pageCount,
      parsedResume,
      analysis,
    });
  } catch (err) {
    if (err instanceof pdfService.UnreadableResumeError) {
      return res.status(422).json({ error: err.message });
    }
    console.error('[resumeController.uploadResume] Failed to process or save resume.');
    return res.status(500).json({ error: 'Failed to process resume.' });
  }
}

// All authenticated reads share the same ownership boundary.
// Invalid IDs (including old demo JWT subjects) never reach Mongoose casting.
async function findOwnedResume(req) {
  if (!mongoose.isObjectIdOrHexString(req.params.id) ||
      !mongoose.isObjectIdOrHexString(req.user.id)) {
    return null;
  }
  return Resume.findOne({
    _id: req.params.id,
    userId: req.user.id,
  }).lean();
}

async function getResume(req, res) {
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    return res.json({ parsedResume: record.parsedResume, analysis: record.analysis });
  } catch {
    console.error('[resumeController.getResume] Database read failed.');
    return res.status(500).json({ error: 'Failed to retrieve resume.' });
  }
}

async function getContext(req, res) {
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    return res.json(record.resumeContext);
  } catch {
    console.error('[resumeController.getContext] Database read failed.');
    return res.status(500).json({ error: 'Failed to retrieve resume context.' });
  }
}

// Questions remain on-demand and are not persisted.
async function getQuestions(req, res) {
  try {
    const record = await findOwnedResume(req);
    if (!record) return res.status(404).json({ error: 'Resume not found.' });
    const result = await questionGeneratorService.generateQuestions(record.resumeContext);
    return res.json(result);
  } catch {
    console.error('[resumeController.getQuestions] Failed to read resume or generate questions.');
    return res.status(500).json({ error: 'Failed to generate questions.' });
  }
}

module.exports = { uploadResume, getResume, getContext, getQuestions };
