import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const ROOT_DIR = resolve('.');
const DATA_DIR = resolve(ROOT_DIR, 'server/data');
const FRONTEND_DIR = resolve(ROOT_DIR, 'frontend');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJson(relativePath) {
  const filePath = resolve(DATA_DIR, relativePath);
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readText(relativePath) {
  const filePath = resolve(DATA_DIR, relativePath);
  return readFile(filePath, 'utf8');
}

async function loadSubjects() {
  const subjects = await readJson('subjects.json');
  return Promise.all(
    subjects.map(async (subject) => {
      const questions = await readJson(subject.questionFile);
      const sections = subject.sections?.length
        ? subject.sections
        : [...new Set(questions.map((item) => item.section))];

      return {
        id: subject.id,
        name: subject.name,
        description: subject.description,
        coverageLabel: subject.coverageLabel || `${questions.length}/${questions.length}`,
        sections,
        stats: {
          total: questions.length,
          choice: questions.filter((item) => item.type === 'choice').length,
          short: questions.filter((item) => item.type === 'short').length,
        },
      };
    }),
  );
}

async function findSubject(subjectId) {
  const subjects = await readJson('subjects.json');
  return subjects.find((subject) => subject.id === subjectId);
}

function filterQuestions(questions, searchParams) {
  const type = searchParams.get('type') || 'all';
  const sectionParams = searchParams.getAll('section');
  const sections = sectionParams.length
    ? sectionParams
    : (searchParams.get('sections') || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

  return questions.filter((question) => {
    const typeMatches = type === 'all' || question.type === type;
    const sectionMatches = !sections.length || sections.includes(question.section);
    return typeMatches && sectionMatches;
  });
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    const subjects = await loadSubjects();
    sendJson(res, 200, { ok: true, subjects: subjects.length });
    return;
  }

  if (url.pathname === '/api/subjects') {
    sendJson(res, 200, await loadSubjects());
    return;
  }

  const subjectMatch = url.pathname.match(/^\/api\/subjects\/([^/]+)(?:\/([^/]+))?$/);
  if (!subjectMatch) {
    sendError(res, 404, 'API endpoint not found');
    return;
  }

  const subjectId = decodeURIComponent(subjectMatch[1]);
  const action = subjectMatch[2] || 'questions';
  const subject = await findSubject(subjectId);

  if (!subject) {
    sendError(res, 404, 'Subject not found');
    return;
  }

  if (action === 'questions') {
    const questions = await readJson(subject.questionFile);
    sendJson(res, 200, filterQuestions(questions, url.searchParams));
    return;
  }

  if (action === 'random') {
    const questions = filterQuestions(await readJson(subject.questionFile), url.searchParams);
    const requestedCount = Number(url.searchParams.get('count') || 10);
    const count = Math.max(1, Math.min(Number.isFinite(requestedCount) ? requestedCount : 10, questions.length));
    sendJson(res, 200, shuffle(questions).slice(0, count));
    return;
  }

  if (action === 'raw') {
    if (!subject.rawFile) {
      sendJson(res, 200, { text: '' });
      return;
    }
    sendJson(res, 200, { text: await readText(subject.rawFile) });
    return;
  }

  sendError(res, 404, 'API endpoint not found');
}

function resolveStaticPath(pathname) {
  const decodedPath = decodeURIComponent(pathname);
  const safePath = normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const requestedPath = safePath === sep || safePath === '/' ? '/index.html' : safePath;
  const filePath = resolve(FRONTEND_DIR, `.${requestedPath}`);

  if (!filePath.startsWith(FRONTEND_DIR)) {
    return null;
  }

  return filePath;
}

async function serveStatic(req, res, url) {
  let filePath = resolveStaticPath(url.pathname);
  if (!filePath) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    await access(filePath);
  } catch {
    filePath = resolve(FRONTEND_DIR, 'index.html');
  }

  const type = contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendError(res, 500, 'Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`Review quiz app running at http://localhost:${PORT}`);
});
