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

function joinAnswerParts(parts) {
  return parts.join('\uff1b');
}

function splitAnswerOption(option) {
  return String(option).split('\uff1b');
}

function objectiveAnswerText(question) {
  const parts = answerPartsFor(question);
  return parts.length ? joinAnswerParts(parts) : String(question.answer || '').trim();
}

function answerPartsFor(question) {
  if (Array.isArray(question.answers)) return unique(question.answers);
  return unique([question.answer]);
}

function partSignature(value) {
  const text = String(value);
  return {
    length: text.length,
    category: normalizedPartCategory(text),
    hasNumber: /\d/.test(text),
    hasBook: /《|》/.test(text),
    hasSlash: /\/|\+/.test(text),
    hasEnglish: /[A-Za-z]/.test(text),
    tail: text.slice(-2),
  };
}

function partCategory(text) {
  if (['数据', '信息', '知识', '符号', '资料'].includes(text)) return 'concept';
  if (['SaaS', 'PaaS', 'IaaS'].includes(text)) return 'cloud-model';
  if (['状态', '转账', '管理', '审核人', '制单人'].includes(text)) return 'field';
  if (['订单', '货单', '发票', '付款单', '关联', '核对'].includes(text)) return 'document-flow';
  if (['资源', '事件', '参与者', '账户', '业务'].includes(text)) return 'rea';
  if (/《|》/.test(text)) return 'document';
  if (/财政|税务|审计|部门/.test(text)) return 'organization';
  if (/阶段$/.test(text)) return 'stage';
  if (/类科目$|科目$/.test(text)) return 'account';
  if (/凭证|凭证录入|凭证审核|凭证修改|凭证汇总|凭证查询|凭证打印|凭证备份/.test(text)) return 'voucher';
  if (/编码$|代码$|账套号/.test(text)) return 'code';
  if (/方法|法$/.test(text)) return 'method';
  if (/模块$/.test(text)) return 'module';
  if (/系统$/.test(text)) return 'system';
  if (/文件$/.test(text)) return 'file';
  if (/性$/.test(text)) return 'attribute';
  if (/度$/.test(text)) return 'metric';
  if (/工资/.test(text)) return 'salary';
  if (/发票/.test(text)) return 'invoice';
  if (/核算/.test(text)) return 'accounting';
  if (/设计/.test(text)) return 'design';
  if (/初始化/.test(text)) return 'initialization';
  if (/化$/.test(text)) return 'state';
  return '';
}

const CLOSED_CATEGORY_VALUES = {
  concept: ['\u6570\u636e', '\u4fe1\u606f', '\u77e5\u8bc6', '\u7b26\u53f7', '\u8d44\u6599'],
  'cloud-model': ['SaaS', 'PaaS', 'IaaS'],
  field: ['\u72b6\u6001', '\u8f6c\u8d26', '\u7ba1\u7406', '\u5ba1\u6838\u4eba', '\u5236\u5355\u4eba'],
  'document-flow': ['\u8ba2\u5355', '\u8d27\u5355', '\u53d1\u7968', '\u4ed8\u6b3e\u5355', '\u5173\u8054', '\u6838\u5bf9'],
  rea: ['\u8d44\u6e90', '\u4e8b\u4ef6', '\u53c2\u4e0e\u8005', '\u8d26\u6237', '\u4e1a\u52a1'],
  code: ['\u987a\u5e8f\u7f16\u7801', '\u4f4d\u6570\u7f16\u7801', '\u5206\u7ec4\u7f16\u7801', '\u79d1\u76ee\u7f16\u7801', '\u5ba2\u6237\u7f16\u7801', '\u5b58\u8d27\u7f16\u7801'],
  metric: ['\u8026\u5408\u5ea6', '\u5185\u805a\u5ea6', '\u51c6\u786e\u5ea6', '\u5b8c\u6574\u5ea6'],
  component: ['\u529f\u80fd', '\u6d41\u7a0b', '\u7ed3\u6784', '\u6a21\u5757'],
};

function normalizedPartCategory(text) {
  const category = partCategory(text);
  if (category) return category;
  if (CLOSED_CATEGORY_VALUES.component.includes(String(text))) return 'component';
  return '';
}

function signatureDistance(a, b) {
  const left = partSignature(a);
  const right = partSignature(b);
  let score = Math.abs(left.length - right.length) * 2;
  if (left.category && right.category && left.category !== right.category) score += 18;
  if (left.category && !right.category) score += 10;
  if (left.category && left.category === right.category) score -= 6;
  if (left.hasNumber !== right.hasNumber) score += 8;
  if (left.hasBook !== right.hasBook) score += 8;
  if (left.hasSlash !== right.hasSlash) score += 4;
  if (left.hasEnglish !== right.hasEnglish) score += 4;
  if (left.tail === right.tail) score -= 3;
  return score;
}

function syntheticPartDistractors(part) {
  const pools = [];
  const add = (items) => pools.push(...items);

  if (/类科目$/.test(part)) add(['资产类科目', '负债类科目', '共同类科目', '权益类科目', '成本类科目', '损益类科目']);
  if (/阶段$/.test(part)) add(['单项数据处理阶段', '会计信息系统阶段', '管理信息系统阶段', '微机网络化阶段', '系统分析阶段', '系统设计阶段', '系统实施阶段', '逻辑设计阶段', '运行维护阶段']);
  if (/凭证$/.test(part)) add(['收款凭证', '付款凭证', '转账凭证', '记账凭证', '原始凭证', '审核凭证']);
  if (/科目$/.test(part)) add(['一级科目', '明细科目', '总账科目', '最底层科目', '会计科目', '临时开账科目']);
  if (/编码$/.test(part)) add(['分组编码', '位数编码', '顺序编码', '科目编码', '客户编码', '存货编码']);
  if (/方法|法$/.test(part)) add(['直接转销法', '备抵法', '先进先出法', '个别计价法', '期末加权平均法', '移动加权平均法', '红字冲销法']);
  if (/部门$/.test(part) || part === '财政部') add(['财政部', '地方各级财政部门', '税务部门', '审计部门', '企业财务部门']);
  if (/模块$/.test(part)) add(['初始化模块', '凭证处理模块', '系统维护模块', '报表生成模块', '数据录入模块']);
  if (/系统$/.test(part)) add(['会计信息系统', '管理信息系统', '账务处理系统', '工资核算系统', '固定资产系统']);
  if (/文件$/.test(part)) add(['科目文件', '凭证文件', '余额文件', '临时凭证文件', '存货结存文件']);
  if (/性$/.test(part)) add(['独立性', '整体性', '目标性', '层次性', '一致性', '可扩展性', '安全性']);
  if (/度$/.test(part)) add(['耦合度', '内聚度', '准确度', '完整度']);
  if (/账|帐/.test(part)) add(['总账', '明细账', '日记账', '银行对账单', '未达账项']);
  if (/工资/.test(part)) add(['应发工资', '实发工资', '代扣款项', '工资结算']);
  if (/发票/.test(part)) add(['销售发票', '采购发票', '普通发票', '增值税发票']);
  if (/核算/.test(part)) add(['客户往来核算', '供应商往来核算', '项目核算', '部门核算', '个人往来核算']);
  if (/设计/.test(part)) add(['结构设计', '逻辑设计', '概要设计', '详细设计']);
  if (/初始化/.test(part)) add(['系统初始化', '科目初始化', '余额初始化', '期初初始化']);
  if (/化$/.test(part)) add(['制度化', '规范化', '标准化', '信息化', '网络化']);
  if (['数据', '信息', '知识'].includes(part)) add(['数据', '信息', '知识', '符号', '资料']);
  if (['SaaS', 'PaaS', 'IaaS'].includes(part)) add(['SaaS', 'PaaS', 'IaaS']);
  if (['状态', '转账', '管理', '审核人'].includes(part)) add(['状态', '转账', '管理', '审核人', '制单人']);
  if (['订单', '货单', '发票', '付款单', '关联', '核对'].includes(part)) add(['订单', '货单', '发票', '付款单', '关联', '核对']);
  if (['资源', '事件', '参与者'].includes(part)) add(['资源', '事件', '参与者', '账户', '业务']);
  if (part === '功能') add(['功能', '数据', '流程', '结构', '模块']);

  return unique(pools).filter((item) => item !== part);
}

function optionDistance(parts, candidateParts) {
  const left = unique(parts);
  const right = unique(candidateParts);
  if (left.length !== right.length) return 1000 + Math.abs(left.length - right.length) * 100;

  return left.reduce((score, part, index) => {
    return score + signatureDistance(part, right[index] || '');
  }, Math.abs(objectiveAnswerText({ answers: left }).length - objectiveAnswerText({ answers: right }).length));
}

function rankedCandidates(items, scoreFor, seed) {
  return unique(items)
    .sort((a, b) => {
      const score = scoreFor(a) - scoreFor(b);
      return score || hashText(`${seed}:${a}`) - hashText(`${seed}:${b}`);
    });
}

function similarParts(question, sourceQuestions, partIndex, limit = 12) {
  const parts = answerPartsFor(question);
  const current = parts[partIndex] || parts[0] || '';
  const currentCategory = normalizedPartCategory(current);
  const generated = syntheticPartDistractors(current);
  const samePosition = sourceQuestions
    .filter((item) => item.id !== question.id)
    .filter((item) => answerPartsFor(item).length === parts.length)
    .map((item) => answerPartsFor(item)[partIndex])
    .filter(Boolean);
  const allParts = sourceQuestions
    .filter((item) => item.id !== question.id)
    .flatMap(answerPartsFor);
  const pool = [...generated, ...samePosition, ...allParts];
  const sameCategory = currentCategory
    ? pool.filter((item) => normalizedPartCategory(item) === currentCategory)
    : [];

  const preferred = rankedCandidates(
    sameCategory,
    (item) => signatureDistance(current, item),
    `${question.id}:part:${partIndex}`,
  ).slice(0, limit);

  if (preferred.length >= limit) return preferred;

  const extra = rankedCandidates(
    pool.filter((item) => !preferred.includes(item)),
    (item) => signatureDistance(current, item),
    `${question.id}:part:${partIndex}:extra`,
  ).slice(0, limit - preferred.length);

  return [...preferred, ...extra];
}

function closedPartPool(part, sourceQuestions) {
  const category = normalizedPartCategory(part);
  if (!category) return [];

  const preset = CLOSED_CATEGORY_VALUES[category] || [];
  const generated = syntheticPartDistractors(part).filter((item) => normalizedPartCategory(item) === category);
  const fromSource = sourceQuestions
    .flatMap(answerPartsFor)
    .filter((item) => normalizedPartCategory(item) === category);

  return unique([...preset, part, ...generated, ...fromSource]);
}

function closedCategoryCombinations(question, sourceQuestions, limit = 12) {
  const parts = answerPartsFor(question);
  const categories = parts.map(normalizedPartCategory);
  const candidates = [];

  if (parts.length > 1 && new Set(categories).size === 1 && categories[0]) {
    for (let offset = 1; offset < parts.length; offset += 1) {
      candidates.push(joinAnswerParts([...parts.slice(offset), ...parts.slice(0, offset)]));
    }
    candidates.push(joinAnswerParts([...parts].reverse()));
    for (let index = 0; index < parts.length - 1; index += 1) {
      const next = [...parts];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      candidates.push(joinAnswerParts(next));
    }
  }

  parts.forEach((part, partIndex) => {
    closedPartPool(part, sourceQuestions).forEach((replacement) => {
      if (replacement === part) return;
      const next = [...parts];
      next[partIndex] = replacement;
      if (new Set(categories).size === 1 && new Set(next).size !== next.length) return;
      candidates.push(joinAnswerParts(next));
    });
  });

  const correct = objectiveAnswerText(question);
  return rankedCandidates(
    unique(candidates)
      .filter((item) => item !== correct)
      .filter((item) => splitAnswerOption(item).length === parts.length),
    (item) => optionDistance(parts, splitAnswerOption(item)),
    `${question.id}:closed-distractors`,
  ).slice(0, limit);
}

function singleDistractors(question, sourceQuestions, count = 3) {
  const parts = answerPartsFor(question);
  const correct = objectiveAnswerText(question);
  const closed = closedCategoryCombinations(question, sourceQuestions, count * 4);

  if (closed.length >= count) return closed.slice(0, count);

  const wholeOptions = sourceQuestions
    .filter((item) => item.id !== question.id)
    .filter((item) => answerPartsFor(item).length === parts.length)
    .map((item) => objectiveAnswerText(item));

  const replacements = [];
  parts.forEach((part, partIndex) => {
    similarParts(question, sourceQuestions, partIndex, 8).forEach((replacement) => {
      if (replacement === part) return;
      const next = [...parts];
      next[partIndex] = replacement;
      replacements.push(joinAnswerParts(next));
    });
  });

  if (parts.length > 1) {
    replacements.push(joinAnswerParts([...parts].reverse()));
  }

  return rankedCandidates(
    [...closed, ...replacements, ...wholeOptions]
      .filter((item) => item !== correct)
      .filter((item) => splitAnswerOption(item).length === parts.length),
    (item) => optionDistance(parts, splitAnswerOption(item)),
    `${question.id}:single-distractors`,
  ).slice(0, count);
}

function multipleDistractors(question, sourceQuestions, correctShown, count) {
  const correctSet = new Set(correctShown);
  const parts = answerPartsFor(question);
  const closed = correctShown.flatMap((answer) => closedPartPool(answer, sourceQuestions));
  const candidates = correctShown.flatMap((answer, fallbackIndex) => {
    const index = parts.indexOf(answer);
    return similarParts(question, sourceQuestions, index >= 0 ? index : fallbackIndex, 10);
  });
  const fallback = sourceQuestions
    .filter((item) => item.id !== question.id)
    .flatMap(answerPartsFor);

  const preferred = rankedCandidates(
    [...closed, ...candidates].filter((item) => !correctSet.has(item)),
    (item) => Math.min(...correctShown.map((answer) => signatureDistance(answer, item))),
    `${question.id}:multiple-distractors`,
  );

  if (preferred.length >= count) return preferred.slice(0, count);

  return rankedCandidates(
    [...preferred, ...fallback].filter((item) => !correctSet.has(item)),
    (item) => Math.min(...correctShown.map((answer) => signatureDistance(answer, item))),
    `${question.id}:multiple-distractors:fallback`,
  ).slice(0, count);
}

function orderedOptions(correctOptions, distractors, seed, targetCount = 4) {
  const correct = unique(correctOptions);
  const wrong = unique(distractors).filter((item) => !correct.includes(item));
  const filler = [];
  let index = 1;
  while (correct.length + wrong.length + filler.length < targetCount) {
    filler.push(`以上说法不完整 ${index}`);
    index += 1;
  }
  return stableSample(unique([...correct, ...wrong, ...filler]).slice(0, targetCount), targetCount, `${seed}:order`);
}

function completeStatement(question) {
  return question.knowledge.replace(/\s+/g, ' ').trim();
}

function falseStatement(question, sourceQuestions) {
  const parts = answerPartsFor(question);
  const statement = completeStatement(question);

  if (parts.length) {
    const index = hashText(`${question.id}:false-index`) % parts.length;
    const wrongPart = similarParts(question, sourceQuestions, index, 12).find((item) => !parts.includes(item));
    if (wrongPart && wrongPart !== parts[index]) {
      return statement.replace(parts[index], wrongPart);
    }
  }

  if (statement.includes('不是')) return statement.replace('不是', '是');
  if (statement.includes('不能')) return statement.replace('不能', '可以');
  if (statement.includes('不需要')) return statement.replace('不需要', '需要');
  if (statement.includes('是')) return statement.replace('是', '不是');
  return '';
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

  for (const question of sourceQuestions) {
    const parts = answerPartsFor(question);
    const answerText = objectiveAnswerText(question);

    if (parts.length) {
      generated.push({
        id: `${question.id}-single`,
        baseId: question.id,
        type: 'single',
        typeName: typeLabel('single'),
        section: question.section,
        prompt: `${question.prompt}\n下列哪一项按顺序填入空格最恰当？`,
        options: orderedOptions([answerText], singleDistractors(question, sourceQuestions), `${question.id}:single`),
        answer: answerText,
        score: 1,
        source: question.source,
        explanation: makeExplanation(question),
        knowledge: question.knowledge,
      });
    }

    if (parts.length >= 2) {
      const correctShown = parts.length <= 3 ? parts : stableSample(parts, 3, `${question.id}:multiple-correct`);
      const distractorCount = 4 - correctShown.length;
      generated.push({
        id: `${question.id}-multiple`,
        baseId: question.id,
        type: 'multiple',
        typeName: typeLabel('multiple'),
        section: question.section,
        prompt: `${question.prompt}\n以下哪些选项属于原题空格的正确答案？`,
        options: orderedOptions(correctShown, multipleDistractors(question, sourceQuestions, correctShown, distractorCount), `${question.id}:multiple`),
        answers: correctShown,
        score: 1.5,
        source: question.source,
        explanation: `本题完整答案：${answerText}\n\n${makeExplanation(question)}`,
        knowledge: question.knowledge,
      });
    }

    generated.push({
      id: `${question.id}-tf-true`,
      baseId: question.id,
      type: 'truefalse',
      typeName: typeLabel('truefalse'),
      section: question.section,
      prompt: `判断：${completeStatement(question)}`,
      options: ['正确', '错误'],
      answer: '正确',
      score: 1,
      source: question.source,
      explanation: makeExplanation(question),
      knowledge: question.knowledge,
    });

    const wrongStatement = falseStatement(question, sourceQuestions);
    if (wrongStatement) {
      generated.push({
        id: `${question.id}-tf-false`,
        baseId: question.id,
        type: 'truefalse',
        typeName: typeLabel('truefalse'),
        section: question.section,
        prompt: `判断：${wrongStatement}`,
        options: ['正确', '错误'],
        answer: '错误',
        score: 1,
        source: question.source,
        explanation: `该说法错误。正确答案：${answerText}\n\n${makeExplanation(question)}`,
        knowledge: question.knowledge,
      });
    }
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
