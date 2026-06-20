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

function isObjectiveNote(value) {
  return /^(其它|其他)/.test(value.trim());
}

function collectOuterParens(value) {
  const segments = [];
  let depth = 0;
  let start = -1;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '（') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '）' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        segments.push(value.slice(start + 1, index).replace(/[ \t]+/g, ' ').trim());
        start = -1;
      }
    }
  }

  return segments;
}

function replaceOuterParens(value, mapper) {
  let result = '';
  let cursor = 0;
  let depth = 0;
  let start = -1;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '（') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '）' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const content = value.slice(start + 1, index).replace(/[ \t]+/g, ' ').trim();
        result += value.slice(cursor, start);
        result += mapper(content);
        cursor = index + 1;
        start = -1;
      }
    }
  }

  return result + value.slice(cursor);
}

function makeObjectiveQuestion(text, index) {
  const promptSource = text.length > 260 ? (text.match(/^.*?。/)?.[0] ?? text) : text;
  const answerParts = unique(collectOuterParens(promptSource).filter((value) => !isObjectiveNote(value)));
  const prompt = answerParts.length
    ? replaceOuterParens(promptSource, (value) => (isObjectiveNote(value) ? '' : '（）'))
    : promptSource;

  return {
    id: `obj-${String(index + 1).padStart(3, '0')}`,
    type: 'choice',
    section: '1. 会计信息系统教材客观题',
    prompt,
    answer: answerParts.length ? answerParts.join('；') : text,
    answers: answerParts,
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

function hashText(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableSample(items, count, seed) {
  return [...items]
    .sort((a, b) => hashText(`${seed}:${a}`) - hashText(`${seed}:${b}`))
    .slice(0, count);
}

function unique(items) {
  return [...new Set(items.map((item) => String(item).replace(/[ \t]+/g, ' ').trim()).filter(Boolean))];
}

function objectiveAnswerText(question) {
  return unique(question.answers?.length ? question.answers : [question.answer]).join('；');
}

function withOptions(correctOptions, distractors, seed, targetCount = 4) {
  const correct = unique(correctOptions);
  const wrong = stableSample(
    distractors.filter((item) => !correct.includes(item)),
    Math.max(0, targetCount - correct.length),
    seed,
  );
  return stableSample(unique([...correct, ...wrong]), targetCount, `${seed}:order`);
}

function typeLabel(type) {
  return {
    single: '单选题',
    multiple: '多选题',
    truefalse: '判断题',
    short: '简答题',
    essay: '论述题',
  }[type] || type;
}

function makeExplanation(question) {
  return question.knowledge || `${question.prompt}\n${question.answer}`.trim();
}

function createObjectiveQuestions(sourceQuestions) {
  const generated = [];
  const combinedDistractors = (question) => unique(
    sourceQuestions
      .filter((item) => item.id !== question.id)
      .map(objectiveAnswerText),
  );
  const partDistractors = (question) => unique(
    sourceQuestions
      .filter((item) => item.id !== question.id)
      .flatMap((item) => item.answers?.length ? item.answers : [item.answer]),
  );

  for (const question of sourceQuestions) {
    const parts = unique(question.answers?.length ? question.answers : [question.answer]);
    const answerText = objectiveAnswerText(question);

    generated.push({
      id: `${question.id}-single`,
      baseId: question.id,
      type: 'single',
      typeName: typeLabel('single'),
      section: question.section,
      prompt: `${question.prompt}\n下列哪一项按顺序填入空格最恰当？`,
      options: withOptions([answerText], combinedDistractors(question), `${question.id}:single`),
      answer: answerText,
      score: 1,
      source: question.source,
      explanation: makeExplanation(question),
      knowledge: question.knowledge,
    });

    if (parts.length >= 2) {
      generated.push({
        id: `${question.id}-multiple`,
        baseId: question.id,
        type: 'multiple',
        typeName: typeLabel('multiple'),
        section: question.section,
        prompt: `${question.prompt}\n以下哪些内容应填入原题空格？`,
        options: withOptions(parts, partDistractors(question), `${question.id}:multiple`, Math.max(4, Math.min(6, parts.length + 2))),
        answers: parts,
        score: 1.5,
        source: question.source,
        explanation: makeExplanation(question),
        knowledge: question.knowledge,
      });
    }

    const wrongAnswer = stableSample(combinedDistractors(question), 1, `${question.id}:tf`)[0] || '以上说法不正确';
    generated.push({
      id: `${question.id}-tf-true`,
      baseId: question.id,
      type: 'truefalse',
      typeName: typeLabel('truefalse'),
      section: question.section,
      prompt: `判断：${question.prompt} 按顺序填入“${answerText}”是正确的。`,
      options: ['正确', '错误'],
      answer: '正确',
      score: 1,
      source: question.source,
      explanation: makeExplanation(question),
      knowledge: question.knowledge,
    });
    generated.push({
      id: `${question.id}-tf-false`,
      baseId: question.id,
      type: 'truefalse',
      typeName: typeLabel('truefalse'),
      section: question.section,
      prompt: `判断：${question.prompt} 按顺序填入“${wrongAnswer}”是正确的。`,
      options: ['正确', '错误'],
      answer: '错误',
      score: 1,
      source: question.source,
      explanation: `该说法错误。正确答案：${answerText}\n\n${makeExplanation(question)}`,
      knowledge: question.knowledge,
    });
  }

  return generated;
}

function createSubjectiveQuestions(sourceQuestions) {
  const generated = [];

  for (const question of sourceQuestions) {
    generated.push({
      id: `${question.id}-short`,
      baseId: question.id,
      type: 'short',
      typeName: typeLabel('short'),
      section: question.section,
      prompt: question.prompt,
      answer: question.answer,
      score: 4,
      source: question.source,
      explanation: makeExplanation(question),
      knowledge: question.knowledge,
    });

    generated.push({
      id: `${question.id}-essay`,
      baseId: question.id,
      type: 'essay',
      typeName: typeLabel('essay'),
      section: question.section,
      prompt: question.prompt,
      answer: question.answer,
      score: 9,
      source: question.source,
      explanation: makeExplanation(question),
      knowledge: question.knowledge,
    });
  }

  return generated;
}

const objectiveQuestions = extractObjectiveQuestions();
const shortQuestions = extractShortQuestions();
const questions = [...objectiveQuestions, ...shortQuestions];
const examQuestions = [
  ...createObjectiveQuestions(objectiveQuestions),
  ...createSubjectiveQuestions(shortQuestions),
];
const rawSource = extractRawText();

if (questions.length === 0) {
  throw new Error('No questions were extracted.');
}

const dataDir = resolve('server/data');
await mkdir(resolve(dataDir, 'questions'), { recursive: true });
await mkdir(resolve(dataDir, 'raw'), { recursive: true });

await writeFile(
  resolve(dataDir, 'questions/accounting-information-systems.json'),
  `${JSON.stringify(examQuestions, null, 2)}\n`,
  'utf8',
);

await mkdir(resolve(dataDir, 'source'), { recursive: true });
await writeFile(
  resolve(dataDir, 'source/accounting-information-systems.json'),
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
    sourceQuestionFile: 'source/accounting-information-systems.json',
    rawFile: 'raw/accounting-information-systems.txt',
    coverageLabel: `${objectiveQuestions.length}道客观题 / ${shortQuestions.length}道问答题`,
    examDistribution: {
      single: { count: 15, score: 1, label: '单选题' },
      multiple: { count: 10, score: 1.5, label: '多选题' },
      truefalse: { count: 15, score: 1, label: '判断题' },
      short: { count: 9, score: 37, label: '简答题' },
      essay: { count: 2, score: 18, label: '论述题' },
    },
    sections,
  },
];

await writeFile(resolve(dataDir, 'subjects.json'), `${JSON.stringify(subjects, null, 2)}\n`, 'utf8');

const typeCounts = examQuestions.reduce((counts, question) => {
  counts[question.type] = (counts[question.type] || 0) + 1;
  return counts;
}, {});
console.log(`Imported ${questions.length} questions from ${sourceFile}`);
console.log(`Generated ${examQuestions.length} exam-ready questions`);
console.log(JSON.stringify(typeCounts));
