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

function sentenceHead(value, maxLength = 96) {
  const cleaned = String(value)
    .replace(/\*\*/g, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  const first = cleaned.match(/^.{8,}?[。；;]/)?.[0] ?? cleaned;
  return first.length > maxLength ? `${first.slice(0, maxLength)}...` : first;
}

function answerParts(question) {
  const source = String(question.answer || question.knowledge || '')
    .replace(/\*\*/g, '')
    .replace(/参考答案/g, '')
    .replace(/[：:]\s*/g, '：');
  const byLine = source
    .split(/\n|。|；|;/)
    .map((part) => part.replace(/^[（(]?\d+[）)]?[、.．]?\s*/, '').trim())
    .filter((part) => part.length >= 2 && part.length <= 120);

  if (byLine.length >= 2) return unique(byLine);

  return unique(
    source
      .split(/、|，|,/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2 && part.length <= 80),
  );
}

function optionPool(questions, currentId) {
  return unique(
    questions
      .filter((question) => question.id !== currentId)
      .map((question) => sentenceHead(question.answer, 72))
      .filter((option) => option.length >= 2),
  );
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

function createExamQuestions(sourceQuestions) {
  const generated = [];
  const allDistractors = (question) => optionPool(sourceQuestions, question.id);

  for (const question of sourceQuestions) {
    const parts = answerParts(question);
    const concise = sentenceHead(question.answer, 90);
    const correctSingle = parts[0] || concise;

    generated.push({
      id: `${question.id}-single`,
      baseId: question.id,
      type: 'single',
      typeName: typeLabel('single'),
      section: question.section,
      prompt: question.type === 'choice'
        ? question.prompt
        : `关于“${question.prompt}”，下列哪一项最接近参考答案要点？`,
      options: withOptions([correctSingle], allDistractors(question), `${question.id}:single`),
      answer: correctSingle,
      score: 1,
      source: question.source,
      explanation: makeExplanation(question),
      knowledge: question.knowledge,
    });

    const correctMultiple = parts.length >= 2 ? parts.slice(0, Math.min(4, parts.length)) : [correctSingle, sentenceHead(question.knowledge, 80)];
    if (unique(correctMultiple).length >= 2) {
      generated.push({
        id: `${question.id}-multiple`,
        baseId: question.id,
        type: 'multiple',
        typeName: typeLabel('multiple'),
        section: question.section,
        prompt: `关于“${question.prompt.replace(/（）/g, '___')}”，正确的说法有：`,
        options: withOptions(correctMultiple, allDistractors(question), `${question.id}:multiple`, Math.max(4, Math.min(6, unique(correctMultiple).length + 2))),
        answers: unique(correctMultiple),
        score: 1.5,
        source: question.source,
        explanation: makeExplanation(question),
        knowledge: question.knowledge,
      });
    }

    const wrongAnswer = stableSample(allDistractors(question), 1, `${question.id}:tf`)[0] || '以上说法不正确';
    generated.push({
      id: `${question.id}-tf-true`,
      baseId: question.id,
      type: 'truefalse',
      typeName: typeLabel('truefalse'),
      section: question.section,
      prompt: `判断：${question.prompt.replace(/（）/g, '___')} 的核心答案包含“${correctSingle}”。`,
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
      prompt: `判断：${question.prompt.replace(/（）/g, '___')} 的核心答案是“${wrongAnswer}”。`,
      options: ['正确', '错误'],
      answer: '错误',
      score: 1,
      source: question.source,
      explanation: `该说法错误。正确要点：${question.answer}\n\n${makeExplanation(question)}`,
      knowledge: question.knowledge,
    });

    generated.push({
      id: `${question.id}-short`,
      baseId: question.id,
      type: 'short',
      typeName: typeLabel('short'),
      section: question.section,
      prompt: question.type === 'short' ? question.prompt : `请简答：${question.prompt.replace(/（）/g, '___')}`,
      answer: question.answer,
      score: 4,
      source: question.source,
      explanation: makeExplanation(question),
      knowledge: question.knowledge,
    });

    if (question.type === 'short' || question.knowledge.length > 180) {
      generated.push({
        id: `${question.id}-essay`,
        baseId: question.id,
        type: 'essay',
        typeName: typeLabel('essay'),
        section: question.section,
        prompt: `请结合复习资料，论述“${question.prompt.replace(/（）/g, '___')}”的核心内容、适用场景和学习要点。`,
        answer: question.answer,
        score: 9,
        source: question.source,
        explanation: makeExplanation(question),
        knowledge: question.knowledge,
      });
    }
  }

  return generated;
}

const questions = [...extractObjectiveQuestions(), ...extractShortQuestions()];
const examQuestions = createExamQuestions(questions);
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
    coverageLabel: `${questions.length}/${questions.length}`,
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
