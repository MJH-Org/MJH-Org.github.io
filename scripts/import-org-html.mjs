import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourceFile = process.argv[2];

if (!sourceFile) {
  console.error('Usage: node scripts/import-org-html.mjs <org-export-html-path>');
  process.exit(1);
}

const html = await readFile(sourceFile, 'utf8');

function decodeHtml(value) {
  const named = {
    amp: '&',
    gt: '>',
    lt: '<',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return value
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
      if (entity.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return named[entity] ?? `&${entity};`;
    })
    .replace(/\u00a0/g, ' ');
}

function cleanText(fragment) {
  return decodeHtml(fragment)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|li|div|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripNumberPrefix(value) {
  return value.replace(/^\s*\d+(?:\.\d+)*\s*/, '').trim();
}

function getSourceSection(number) {
  if (number.startsWith('2.')) return '2. 会计信息系统教材问答题';
  if (number.startsWith('3.')) return '3. 用友U8相关问答题';
  if (number.startsWith('4.')) return '4. ERPNext实验相关问答题';
  return '1. 会计信息系统教材客观题';
}

function makeObjectiveQuestion(text, index) {
  const promptSource = text.length > 260 ? (text.match(/^.*?。/)?.[0] ?? text) : text;
  const answerSource = promptSource + [...text.matchAll(/（([^（）]+)）/g)]
    .map((match) => match[1].replace(/[ \t]+/g, ' ').trim())
    .filter((value) => value.startsWith('其它'))
    .map((value) => `（${value}）`)
    .join('');
  const answerParts = [...new Set([...answerSource.matchAll(/（([^（）]+)）/g)]
    .map((match) => match[1].replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean))];
  const prompt = answerParts.length
    ? promptSource.replace(/（([^（）]+)）/g, (_, value) => (value.trim().startsWith('其它') ? '' : '（）'))
    : promptSource;

  return {
    id: `obj-${String(index + 1).padStart(3, '0')}`,
    type: 'choice',
    section: '1. 会计信息系统教材客观题',
    prompt,
    answer: answerParts.length ? answerParts.join('；') : text,
    source: `HTML原文 / 客观题${index + 1}`,
    knowledge: text,
  };
}

function extractObjectiveQuestions() {
  const sectionMatch = html.match(/<h2[^>]*>\s*<span[^>]*>1<\/span>\s*会计信息系统教材客观题<\/h2>([\s\S]*?)(?=<div id="outline-container-[^"]+" class="outline-2">)/);
  if (!sectionMatch) {
    throw new Error('Cannot find objective question section.');
  }

  return [...sectionMatch[1].matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((match) => cleanText(match[1]))
    .filter(Boolean)
    .map(makeObjectiveQuestion);
}

function extractShortQuestions() {
  const h3Pattern = /<h3[^>]*>\s*<span[^>]*>(\d+\.\d+)<\/span>\s*([\s\S]*?)<\/h3>\s*<div class="outline-text-3"[^>]*>([\s\S]*?)(?=<div id="outline-container-[^"]+" class="outline-3">|<div id="outline-container-[^"]+" class="outline-2">|<div id="postamble"|<\/body>)/g;

  return [...html.matchAll(h3Pattern)]
    .map((match) => {
      const number = match[1];
      const title = cleanText(match[2]);
      const answer = cleanText(match[3]);
      return {
        id: `qa-${number.replace('.', '-')}`,
        type: 'short',
        section: getSourceSection(number),
        prompt: stripNumberPrefix(title),
        answer,
        source: `HTML原文 / ${number}`,
        knowledge: `${stripNumberPrefix(title)}\n${answer}`.trim(),
      };
    })
    .filter((question) => question.prompt && question.answer);
}

function extractRawText() {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : html;
  return cleanText(
    body
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, ''),
  );
}

const questions = [...extractObjectiveQuestions(), ...extractShortQuestions()];
const rawSource = extractRawText();

if (questions.length === 0) {
  throw new Error('No questions were extracted.');
}

const dataDir = resolve('server/data');
await mkdir(resolve(dataDir, 'questions'), { recursive: true });
await mkdir(resolve(dataDir, 'raw'), { recursive: true });

await writeFile(
  resolve(dataDir, 'questions/accounting-information-systems.json'),
  `${JSON.stringify(questions, null, 2)}\n`,
  'utf8',
);

await writeFile(
  resolve(dataDir, 'raw/accounting-information-systems.txt'),
  `${rawSource}\n`,
  'utf8',
);

const sections = [...new Set(questions.map((item) => item.section))];
const subjects = [
  {
    id: 'accounting-information-systems',
    name: '会计信息系统',
    description: '从《会计信息系统复习题(2026)》HTML版导入的结构化题库',
    questionFile: 'questions/accounting-information-systems.json',
    rawFile: 'raw/accounting-information-systems.txt',
    coverageLabel: `${questions.length}/${questions.length}`,
    sections,
  },
];

await writeFile(resolve(dataDir, 'subjects.json'), `${JSON.stringify(subjects, null, 2)}\n`, 'utf8');

const choiceCount = questions.filter((question) => question.type === 'choice').length;
const shortCount = questions.filter((question) => question.type === 'short').length;
console.log(`Imported ${questions.length} questions from ${sourceFile}`);
console.log(`choice=${choiceCount}; short=${shortCount}`);
