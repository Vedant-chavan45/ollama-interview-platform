# Resume Processing Module (Module 4)

## Quick start: local Ollama question-generation demo

This project uses the locally installed Ollama model; **no Ollama website account or API key is needed** for `http://localhost:11434`.

1. Install Node.js 20 LTS (Node 18+ is supported) and ensure Ollama is running.
2. Confirm the model is installed with `ollama list`. This project defaults to `llama3.2:latest`.
3. Copy `.env.example` to `.env` in PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   Keep any existing `.env` file and merge the Ollama settings instead of overwriting your database/JWT settings.
4. The ZIP includes the JavaScript dependencies so you can run the CLI demo immediately after extracting it. To refresh/reinstall dependencies when internet access is available, run:

   ```powershell
   npm install
   ```

5. Run a one-role evaluation using the included sample resume. This command does not require MongoDB:

   ```powershell
   npm run evaluate:questions -- test/sample_resume.pdf --role "Backend Developer"
   ```

   For a live AI result, the output should label question generation `SOURCE: AI (ollama-llama3.2)`. If it says `heuristic fallback`, the local model request did not finish or the response did not pass validation; the fallback is clearly labelled and is not counted as an AI result. To see safe diagnostic categories for one run, set `$env:DEBUG_QUESTION_GENERATION = "1"` in PowerShell before running the evaluation, then remove that variable afterwards.

6. Run the automated suite:

   ```powershell
   npm test
   ```

The question generator requests six short JSON strings and assigns question types and resume evidence anchors in Node.js. Its output is still checked by the existing validator. Question generation is bounded by `QUESTION_GENERATION_TIMEOUT_MS` (90 seconds by default); it returns a labelled deterministic fallback if the local model times out or fails validation.

The browser application is separate from this CLI demo and requires a working MongoDB URI in `.env` before `npm start`.

---

## MongoDB Checkpoint 2

The HTTP server requires MongoDB. Users now persist in MongoDB alongside the unchanged Checkpoint 1 resume storage. Authentication continues to use bcryptjs, JWT Bearer tokens and frontend localStorage.

1. Copy `.env.example` to `.env` (which remains gitignored).
2. Set `MONGODB_URI` to your own MongoDB Atlas connection string. Configure an Atlas database user with access to the database and permit this machine in Atlas Network Access. Never commit the URI.
3. Keep `MONGODB_DB_NAME=mock_interview_platform`, or choose your database name.
4. Keep `DEMO_USER_ID=000000000000000000000001` exactly. Startup rejects a different ID because existing resumes already belong to this identity. Set `JWT_SECRET` to a private signing secret; changing it invalidates existing tokens.
5. Run `npm install`, then `npm start`. Startup connects to MongoDB, ensures the unique User email index, seeds the demo user, then listens. Connection/index/seed failures stop startup with a sanitized error.

Mongoose is pinned to 8.24.4, compatible with Node 20.11.0. The connection is implemented in `src/config/database.js`; the nested resume schema and owner/date index are in `src/models/Resume.js`.

Uploads persist file metadata, parsed data, analysis, context, owner, page count, and timestamps. PDF buffers, raw extracted text, and generated questions are not stored. All resume/context/question reads filter by both resume ID and authenticated user ID. Invalid IDs and unavailable/foreign records return 404.

`GET /health` returns `mongodb` connection state and HTTP 200 while connected, or HTTP 503 otherwise. This reports driver connection state, not an active database ping.

Resume API payloads remain unchanged; resume IDs are ObjectId strings. Signup and login both return `{ token, user: { id, name, email } }`. There is no resume-history interface. The CLI pipeline remains independent of MongoDB.

Run `npm test` for the checkpoint regression and auth unit tests. The explicit test filenames work on Windows without shell glob expansion.

Run `npm run test:integration` for real MongoDB checks. Set `MONGODB_TEST_DB_NAME=mock_interview_platform_test`; tests use `MONGODB_TEST_URI` if supplied, otherwise `MONGODB_URI`, always overriding the URI database with the verified test database name. The configured name must contain a separate `test` segment (separated by underscores or hyphens), must not be `mock_interview_platform`, and must differ from `MONGODB_DB_NAME`. These checks run before connecting and before cleanup, including verification of the actual connected database name. No database or collection is dropped: cleanup deletes only record IDs created by the test run. Existing test records are preserved. Without a configured URI the MongoDB scenario is skipped; unsafe database names fail the suite.

Integration coverage uses real database writes and HTTP routes, including PDF upload, cross-user ownership checks, legacy demo ownership and reconnect persistence. Ollama and question generation are stubbed within tests so these checks do not require external model services.


**Owner:** Siddhant Raikar — BTech Capstone, Group P49, "AI-Powered Mock Interview Platform"
**Scope:** Resume Processing & Resume Intelligence — turns an uploaded PDF resume into a structured, machine-usable profile that the Interview module (Modules 1/3) uses to generate personalised questions.

This is a real, runnable implementation of the module — not a mockup. It matches the class diagram, use case diagram, activity diagram and LLD flow already presented: `Upload → Validate → Extract Text → Parse Sections → LLM Analysis (with heuristic fallback) → Build Resume Context`.

---

## 1. What's inside

```
src/
  services/
    pdfService.js          PDF validation + text extraction (pdf-parse, with a pdftotext fallback)
    resumeParserService.js Section-aware parser: skills, projects, experience, education, certifications
    ollamaService.js       Sends parsed resume to a local Llama 3.2 (via Ollama) for analysis;
                            falls back to a deterministic heuristic summary if Ollama isn't reachable
    contextBuilder.js       Builds the final ResumeContext object handed off to the Interview module
    questionGeneratorService.js  Demo-only: generates sample interview questions from a ResumeContext
                            (architecturally belongs to the Interview module — see section 3 below)
    authService.js          JWT issuing/verification + bcrypt password hashing
    userStore.js             Asynchronous MongoDB User lookups and creation
    seedDemoUser.js          Idempotent fixed-ID demo migration
  models/
    User.js                 User schema, hidden password hash and unique email index
    Resume.js               Unchanged persisted resume schema
  controllers/
    resumeController.js     Express controller: upload / get / get-context / get-questions
    authController.js        Express controller: signup / login / me
  middleware/
    authMiddleware.js        Protects routes behind a valid JWT
  routes/
    resumeRoutes.js          /api/resume routes (behind login)
    authRoutes.js             /api/auth routes
server.js                    Standalone Express app (so this module can run and be demoed on its own)
public/
  login.html                  Login page (served at http://localhost:5001/login.html)
  index.html                  Drag-and-drop demo webpage (served at http://localhost:5001/, requires login)
test/
  generate_sample_resume.py  Generates a realistic sample PDF resume (reportlab)
  sample_resume.pdf          (generated, see below)
  parseSample.js              CLI demo: runs the full pipeline with readable step-by-step output
```

## 2. Install

```bash
npm install
```

Requires Node.js 18+. `pdftotext` (from `poppler-utils`) is optional but recommended as a fallback text extractor — install it with `apt install poppler-utils` / `brew install poppler` if you want the extra reliability; the module works without it.

## 3. Demo webpage (recommended for showing the mentor)

The module now ships with a simple, self-contained demo webpage — drag-and-drop a resume PDF in the browser and see it parsed live. No Postman, no terminal output to read out loud.

```bash
npm install
npm start
```

Then open **http://localhost:5001/** in a browser. You'll land on a login page first (see below) — sign in, then drag in any resume PDF (yours, the generated sample, or a teammate's), optionally set an interview type / target role, and click **Parse Resume**. It shows: skills detected, projects, experience, education, the AI/heuristic analysis (clearly labeled which one ran), and the raw JSON response — exactly what the Interview module would receive.

### Sign up and sign in

Open `/login.html` and select **Create an account**. Enter your name, email, password and confirmation. Signup validates inputs on the server: name must be a nonblank string of at most 100 characters, email must have a valid format and be at most 254 characters, password must have at least 8 characters and at most 72 UTF-8 bytes, and confirmation must match. Email is trimmed and lowercased. A unique MongoDB index enforces uniqueness, including concurrent signup attempts.

- `POST /api/auth/signup` accepts `{ name, email, password, confirmPassword }` and returns HTTP 201 with `{ token, user: { id, name, email } }`. Invalid input returns 400; duplicate email returns 409.
- `POST /api/auth/login` accepts `{ email, password }`, verifies the MongoDB account using bcrypt, and returns the same response shape with HTTP 200. Incorrect passwords and unknown emails both return HTTP 401 with `Invalid email or password.`
- `GET /api/auth/me` continues to return `{ user }` for a valid `Authorization: Bearer <token>` header.

Both signup and signin automatically store the returned JWT and public user in the existing localStorage keys, then open the resume interface. New users get MongoDB-generated ObjectIds. Password hashes are excluded from normal user lookups and never returned in auth responses. Neither plaintext passwords nor password confirmations are stored. Resume ownership still follows JWT subject -> `req.user.id` -> `Resume.userId`.

### Existing demo user

The first startup creates the demo user from these initial settings:

```
DEMO_USER_ID=000000000000000000000001
DEMO_USER_EMAIL=siddhant@capstone.demo
DEMO_USER_PASSWORD=demo1234
DEMO_USER_NAME=Siddhant Raikar
```

The fixed ID preserves access to existing demo-owned resumes without rewriting any Resume documents. If a matching account exists, seeding leaves all its fields, password hash and timestamps untouched. Changing environment values does not reset an existing password. If the configured email belongs to another ID, or the fixed ID belongs to another email, startup fails clearly instead of overwriting either account. Concurrent startup handles a duplicate insert only after confirming the winning account has the same identity.

Configure demo credentials before the initial seed. Keep the signing secret stable to retain current JWT validity; the existing demo fallback secret remains in the unchanged auth service, so explicitly configure a private `JWT_SECRET` for deployment.

If Ollama isn't installed/running on the demo machine, the page still works end-to-end — it just shows a **"Heuristic fallback"** tag instead of **"LLM (Ollama)"** on the analysis section, which is the intended graceful-degradation behaviour, not a bug.

### "Generate Interview Questions" button

After a resume is parsed, a **Generate Interview Questions** button appears. Clicking it calls `GET /api/resume/:id/questions` and shows 6 personalised questions built directly from *this* candidate's skills, projects and experience (2 technical, 2 project-based, 1 about their experience, 1 behavioral) — with the same LLM/heuristic-fallback labeling as the analysis step.

**Architecture honesty note:** on the module dependency slide, personalised question generation belongs to the Interview module (Modules 1/3) — Module 4's real scope ends at producing the `ResumeContext` object and handing it off (see `contextBuilder.js`). `questionGeneratorService.js` is included here so the demo can show the *whole* flow end-to-end in one place, and it's commented accordingly. If a mentor asks "isn't that Module 1/3's job?", the honest answer is yes — this is a demo convenience that consumes the exact same `ResumeContext` handoff the Interview module would, not a claim that Module 4 owns question generation.

## 4. CLI demo (no server, no browser — good as a backup)

This is the simplest fallback if a browser/server demo isn't convenient — it needs nothing but Node.

```bash
# 1. Generate a sample resume PDF (only needed once — or point it at your own real PDF)
python3 test/generate_sample_resume.py

# 2. Run the full pipeline against it
npm run demo
# equivalent to: node test/parseSample.js
```

You'll see, step by step, in the terminal:

1. **PDF text extraction** — page count, characters extracted, extraction time.
2. **Section parsing** — the full structured JSON: skills, projects, experience, education, certifications, and a `meta` block listing which sections were detected and any warnings.
3. **LLM resume analysis** — sends the parsed resume to Ollama (`llama3.2` by default) for a short qualitative analysis (strengths, suggested focus areas). If Ollama isn't installed/running, this **automatically and transparently falls back** to a deterministic heuristic analysis instead of failing — the output always says which one it used via `"source": "ollama-llama3.2"` or `"source": "heuristic-fallback"`.
4. **Resume Context** — the final object this module hands to the Interview module for personalised question generation.

To run it against your **own** resume PDF instead of the generated sample:

```bash
node test/parseSample.js /path/to/any_resume.pdf
```

### If asked "what happens if the LLM is down?" live

Say exactly what the code does: analysis never throws or blocks the pipeline. If Ollama can't be reached within the timeout, `ollamaService` catches it and returns a clearly labelled heuristic fallback built directly from the parsed resume (skill count, section presence, etc.), so the rest of the pipeline — and the demo — never breaks. This is the "graceful degradation on AI service failure" NFR from the design slides, implemented, not just diagrammed.

## 5. Demo as a live API (optional, if you want to show Postman/curl)

```bash
npm start
# Resume Processing module listening on http://localhost:5001
```

```bash
# Health check (not behind auth)
curl http://localhost:5001/health

# Log in to get a token
curl -X POST -H "Content-Type: application/json" \
     -d '{"email":"siddhant@capstone.demo","password":"demo1234"}' \
     http://localhost:5001/api/auth/login
# => { "token": "...", "user": {...} }

# Upload a resume (resume routes require the token)
curl -H "Authorization: Bearer <token from above>" \
     -F "resume=@test/sample_resume.pdf" \
     -F "interviewType=Technical" \
     -F "targetRole=SDE Intern" \
     http://localhost:5001/api/resume/upload

# Fetch the resume context that would be sent to the Interview module
curl -H "Authorization: Bearer <token>" http://localhost:5001/api/resume/<resumeId>/context

# Generate personalised interview questions
curl -H "Authorization: Bearer <token>" http://localhost:5001/api/resume/<resumeId>/questions
```

Uploading a non-PDF file correctly returns a clean `422`/validation error instead of a crash — useful if a mentor asks about error handling:

```bash
echo "not a pdf" > /tmp/test.txt
curl -F "resume=@/tmp/test.txt" http://localhost:5001/api/resume/upload
```

Environment variables (see `.env.example`; `MONGODB_URI` is required):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 5001 | Port for the standalone demo server |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Where Ollama is running |
| `OLLAMA_MODEL` | llama3.2 | Model name to call |
| `OLLAMA_TIMEOUT_MS` | 120000 | Per-request Ollama timeout in milliseconds; question generation is additionally capped by `QUESTION_GENERATION_TIMEOUT_MS` |
| `JWT_SECRET` | (demo default — change it) | Secret used to sign login tokens |
| `JWT_EXPIRES_IN` | 4h | JWT lifetime |
| `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` / `DEMO_USER_NAME` | see `.env.example` | Initial demo seed values; existing accounts are not overwritten |
| `DEMO_USER_ID` | 000000000000000000000001 | Required fixed demo identity for legacy resume ownership |
| `MONGODB_URI` | required | Private MongoDB connection string |
| `MONGODB_DB_NAME` | mock_interview_platform | Application database |
| `MONGODB_TEST_DB_NAME` | mock_interview_platform_test | Dedicated integration test database |
| `MONGODB_TEST_URI` | falls back to `MONGODB_URI` | Optional separate test-server connection string |

## 6. Integration into the main project

This module was deliberately kept self-contained (own `server.js`, own routes) so it can be demoed standalone, but it is designed to be mounted directly into the team's real Express backend with minimal changes:

1. **Copy the module in.** Drop `src/services/*`, `src/controllers/resumeController.js`, and `src/routes/resumeRoutes.js` into the main backend's equivalent folders (or keep this folder and `require` it from the main `app.js`).

2. **Mount the routes.** In the main app's entry file:
   ```js
   const resumeRoutes = require('./resume-parser-module/src/routes/resumeRoutes');
   app.use('/api/resume', resumeRoutes);
   ```

3. **Resume persistence is implemented.** MongoDB Checkpoint 1 uses the Resume model and owner-filtered queries. When merging into the main backend, reuse its connection and preserve ownership checks.

4. **Preserve authentication identity when integrating.** This module provides MongoDB User accounts, signup/signin and JWT Bearer middleware. If the main backend has its own User model, reconcile identities before switching authentication. Keep `req.user.id` compatible with persisted `Resume.userId` and preserve the fixed legacy demo ID.

5. **Hand off to the Interview module.** `GET /api/resume/:id/context` returns exactly the `ResumeContext` object (`skills`, `projects`, `experienceSummary`, `education`, `candidateSummary`, `strengths`, `skillAreasToProbe`, `interviewType`, `targetRole`, `analysisSource`) that Modules 1/3 need to generate personalised questions — this is the same handoff shown on the module dependency slide ("Siddhant → provides processed resume context for personalised AI question generation"). The Interview module just needs to call that endpoint (or, once merged into one app, call `contextBuilder.build(...)` directly) after a resume is uploaded.

6. **Ollama.** Point `OLLAMA_BASE_URL` at wherever the team's Ollama instance actually runs (local machine, a shared server, etc.). No code change needed — and if it's ever unreachable in production, the heuristic fallback keeps the feature usable rather than broken.

## 7. Honest status (for the mentor, and for the team)

- The parsing, extraction, fallback logic, and context-building are real, working code — tested against a generated PDF, a real resume, and via a live server with curl, including a deliberate invalid-file-type test.
- Resume and user storage use MongoDB. Checkpoint 2 adds signup and preserves the existing JWT/Bearer architecture and resume ownership.
- LLM analysis and question generation depend on Ollama being installed and running with the `llama3.2` model pulled (`ollama pull llama3.2`); without it, both still work end-to-end via their heuristic fallbacks, clearly labelled as such in the output.
- OCR for scanned/image-only PDFs is out of scope for this MVP (also stated in the LLD) — such files are correctly rejected as "unreadable" with a clear error rather than silently failing.
- Question generation (`questionGeneratorService.js`) is included for a complete end-to-end demo, but architecturally belongs to the Interview module (Modules 1/3) on the team's module dependency slide — say so plainly if asked.
- Signup and signin use MongoDB-backed users with bcrypt password hashes and JWTs. Email verification, password recovery and account-management screens are outside this checkpoint.
