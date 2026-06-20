const TYPE_META = {
  single: { label: '单选题', className: 'type-single', objective: true },
  multiple: { label: '多选题', className: 'type-multiple', objective: true },
  truefalse: { label: '判断题', className: 'type-truefalse', objective: true },
  short: { label: '简答题', className: 'type-short', objective: false },
  essay: { label: '论述题', className: 'type-essay', objective: false },
};

const DEFAULT_DISTRIBUTION = {
  single: { count: 15, score: 1, label: '单选题' },
  multiple: { count: 10, score: 1.5, label: '多选题' },
  truefalse: { count: 15, score: 1, label: '判断题' },
  short: { count: 9, score: 37, label: '简答题' },
  essay: { count: 2, score: 18, label: '论述题' },
};

const PRACTICE_TYPES = ['single', 'multiple', 'truefalse', 'short', 'essay'];

const state = {
  page: document.body.dataset.page || 'quiz',
  subjects: [],
  subject: null,
  questions: [],
  raw: '',
  quiz: [],
  answered: {},
  apiMode: true,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  })[char]);
}

function formatText(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function sample(items, count) {
  return shuffle(items).slice(0, count);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.text();
}

async function loadSubjects() {
  try {
    state.apiMode = true;
    return await fetchJson('/api/subjects');
  } catch {
    state.apiMode = false;
    return fetchJson('data/subjects.json');
  }
}

async function loadSubjectQuestions(subject) {
  if (state.apiMode) {
    return fetchJson(`/api/subjects/${encodeURIComponent(subject.id)}/questions`);
  }
  return fetchJson(`data/${subject.questionFile}`);
}

async function loadSubjectRaw(subject) {
  if (state.apiMode) {
    const payload = await fetchJson(`/api/subjects/${encodeURIComponent(subject.id)}/raw`);
    return payload.text || '';
  }
  return subject.rawFile ? fetchText(`data/${subject.rawFile}`) : '';
}

function setupHeaderAutoHide() {
  const header = $('.app-header');
  if (!header) return;
  let lastY = window.scrollY || 0;
  let ticking = false;

  function apply() {
    const y = window.scrollY || 0;
    const delta = y - lastY;
    if (y <= 8) header.classList.remove('header-hidden');
    else if (delta > 10) {
      header.classList.add('header-hidden');
      lastY = y;
    } else if (delta < -10) {
      header.classList.remove('header-hidden');
      lastY = y;
    } else if (Math.abs(delta) <= 2) {
      lastY = y;
    }
    ticking = false;
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(apply);
      ticking = true;
    }
  }, { passive: true });
}

async function init() {
  setupHeaderAutoHide();
  bindEvents();

  try {
    state.subjects = await loadSubjects();
    renderSubjectOptions();
    if (state.subjects.length) {
      await loadSubject(state.subjects[0].id);
    } else if ($('#quizInfo')) {
      $('#quizInfo').textContent = '还没有可用学科。';
    }
  } catch (error) {
    console.error(error);
    if ($('#quizInfo')) $('#quizInfo').textContent = '题库加载失败，请检查数据文件。';
    if ($('#kbList')) $('#kbList').innerHTML = '<div class="empty">题库加载失败。</div>';
  }
}

function bindEvents() {
  $('#subjectSelect')?.addEventListener('change', (event) => loadSubject(event.target.value));
  $('#examBtn')?.addEventListener('click', generateExam);
  $('#practiceBtn')?.addEventListener('click', generatePractice);
  $('#resetBtn')?.addEventListener('click', resetQuiz);
  $('#kbSearch')?.addEventListener('input', renderKnowledgeBase);
  $('#kbType')?.addEventListener('change', renderKnowledgeBase);
  $('#kbSection')?.addEventListener('change', renderKnowledgeBase);
  $('#sourceSearch')?.addEventListener('input', renderSourceViewer);
  $('#sourceSection')?.addEventListener('change', renderSourceViewer);

  $('#quizList')?.addEventListener('click', (event) => {
    const submitButton = event.target.closest('[data-action="submit-objective"]');
    if (submitButton) {
      submitObjective(submitButton.dataset.id);
      return;
    }

    const revealButton = event.target.closest('[data-action="reveal-subjective"]');
    if (revealButton) {
      revealSubjective(revealButton.dataset.id);
    }
  });
}

function renderSubjectOptions() {
  const select = $('#subjectSelect');
  if (!select) return;
  select.innerHTML = state.subjects
    .map((subject) => `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.name)}</option>`)
    .join('');
}

async function loadSubject(subjectId) {
  const subject = state.subjects.find((item) => item.id === subjectId);
  if (!subject) return;

  state.subject = subject;
  $('#subjectSelect').value = subjectId;
  if ($('#quizInfo')) $('#quizInfo').textContent = '正在加载题库...';

  const [questions, rawText] = await Promise.all([
    loadSubjectQuestions(subject),
    loadSubjectRaw(subject),
  ]);

  state.questions = questions;
  state.raw = rawText;
  state.quiz = [];
  state.answered = {};

  renderStats();
  renderPracticeTypeFilters();
  renderSectionFilters();
  renderKnowledgeFilters();
  renderExamBlueprint();

  if (state.page === 'bank') {
    renderKnowledgeBase();
    $('#rawSource').textContent = state.raw;
  } else if (state.page === 'source') {
    renderSourceFilters();
    renderSourceViewer();
  } else {
    resetQuiz(false);
  }
}

function getTypeCount(type) {
  return state.questions.filter((question) => question.type === type).length;
}

function renderStats() {
  $('#totalCount').textContent = state.questions.length;
  $('#singleCount').textContent = getTypeCount('single');
  $('#multipleCount').textContent = getTypeCount('multiple');
  $('#truefalseCount').textContent = getTypeCount('truefalse');
  $('#subjectiveCount').textContent = getTypeCount('short') + getTypeCount('essay');
}

function renderExamBlueprint() {
  const container = $('#examBlueprint');
  if (!container) return;
  const distribution = getDistribution();
  container.innerHTML = Object.entries(distribution)
    .map(([type, config]) => {
      const suffix = TYPE_META[type].objective ? `${config.score} 分/题` : `共 ${config.score} 分`;
      return `<span class="blueprint-pill">${config.label} ${config.count} 题，${suffix}</span>`;
    })
    .join('');
}

function renderPracticeTypeFilters() {
  const container = $('#typeChecks');
  if (!container) return;
  container.innerHTML = PRACTICE_TYPES
    .map((type) => {
      const meta = TYPE_META[type];
      const count = getTypeCount(type);
      return `
        <label class="check-pill type-check-pill">
          <input type="checkbox" value="${escapeHtml(type)}" ${count ? 'checked' : 'disabled'}>
          <span>${escapeHtml(meta.label)} <strong>${count}</strong></span>
        </label>
      `;
    })
    .join('');
}

function renderSectionFilters() {
  const container = $('#sectionChecks');
  if (!container) return;
  const sections = [...new Set(state.questions.map((item) => item.section))];
  container.innerHTML = sections
    .map((section) => `
      <label class="check-pill">
        <input type="checkbox" value="${escapeHtml(section)}" checked>
        <span>${escapeHtml(section)}</span>
      </label>
    `)
    .join('');
}

function renderKnowledgeFilters() {
  const select = $('#kbSection');
  if (!select) return;
  const sections = [...new Set(state.questions.map((item) => item.section))];
  select.innerHTML = '<option value="all">全部章节</option>'
    + sections.map((section) => `<option value="${escapeHtml(section)}">${escapeHtml(section)}</option>`).join('');
}

function parseSourceSections() {
  const lines = state.raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let current = { key: 'toc', title: '目录', lines: [] };
  let reachedBody = false;

  function pushCurrent() {
    if (current.lines.length) sections.push(current);
  }

  lines.forEach((line) => {
    const major = line.match(/^([1-4])\s+(.+)/);
    const minor = line.match(/^([2-4]\.\d+)\s+(.+)/);
    const heading = major || minor;

    if (heading && (reachedBody || major)) {
      reachedBody = true;
      pushCurrent();
      current = {
        key: heading[1],
        title: `${heading[1]} ${heading[2]}`,
        lines: [],
      };
      return;
    }

    current.lines.push(line);
  });

  pushCurrent();
  return sections;
}

function renderSourceFilters() {
  const select = $('#sourceSection');
  if (!select) return;
  const sections = parseSourceSections();
  select.innerHTML = '<option value="all">全部资料</option>'
    + sections.map((section) => `<option value="${escapeHtml(section.key)}">${escapeHtml(section.title)}</option>`).join('');
}

function renderSourceViewer() {
  if (!$('#sourceList')) return;
  const keyword = $('#sourceSearch')?.value.trim().toLowerCase() || '';
  const sectionKey = $('#sourceSection')?.value || 'all';
  const sections = parseSourceSections();
  const list = sections.filter((section) => {
    const sectionMatches = sectionKey === 'all' || section.key === sectionKey;
    const haystack = `${section.title}\n${section.lines.join('\n')}`.toLowerCase();
    return sectionMatches && (!keyword || haystack.includes(keyword));
  });

  $('#sourceStats').textContent = `当前显示 ${list.length} / ${sections.length} 段资料。`;
  $('#sourceList').innerHTML = list.map((section) => `
    <article class="source-card" id="source-${escapeHtml(section.key)}">
      <h2>${escapeHtml(section.title)}</h2>
      <div class="source-text">${formatText(section.lines.join('\n'))}</div>
    </article>
  `).join('') || '<div class="empty">没有匹配的资料内容。</div>';
}

function getDistribution() {
  return state.subject?.examDistribution || DEFAULT_DISTRIBUTION;
}

function getEnabledSections() {
  return $$('#sectionChecks input:checked').map((input) => input.value);
}

function getEnabledPracticeTypes() {
  return $$('#typeChecks input:checked').map((input) => input.value);
}

function getEligibleQuestions(types = 'all') {
  const enabledSections = getEnabledSections();
  const requestedTypes = Array.isArray(types) ? types : [types];
  const allTypes = requestedTypes.includes('all');
  return state.questions.filter((question) => {
    const typeMatches = allTypes || requestedTypes.includes(question.type);
    const sectionMatches = !enabledSections.length || enabledSections.includes(question.section);
    return typeMatches && sectionMatches;
  });
}

function distributeSubjectiveScores(questions, totalScore) {
  if (!questions.length) return questions;
  const base = Math.floor(totalScore / questions.length);
  const remainder = totalScore - base * questions.length;
  return questions.map((question, index) => ({
    ...question,
    score: base + (index < remainder ? 1 : 0),
  }));
}

function generateExam() {
  const distribution = getDistribution();
  const nextQuiz = [];
  const missing = [];

  Object.entries(distribution).forEach(([type, config]) => {
    const pool = getEligibleQuestions(type);
    const picked = sample(pool, config.count);
    if (picked.length < config.count) {
      missing.push(`${config.label}缺 ${config.count - picked.length} 题`);
    }

    const scored = TYPE_META[type].objective
      ? picked.map((question) => ({ ...question, score: config.score }))
      : distributeSubjectiveScores(picked, config.score);
    nextQuiz.push(...scored);
  });

  state.quiz = nextQuiz;
  state.answered = {};
  renderQuiz(missing.length ? `已按可用题量生成，${missing.join('，')}。` : '已生成期末模拟卷：共 100 分。');
}

function generatePractice() {
  const types = getEnabledPracticeTypes();
  const eligible = types.length ? getEligibleQuestions(types) : [];
  let count = Math.max(1, Number.parseInt($('#countInput').value || '1', 10));

  if (!types.length) {
    $('#quizList').innerHTML = '<div class="empty">请至少选择一种练习题型。</div>';
    $('#quizInfo').textContent = '请至少选择一种练习题型。';
    updateProgress();
    return;
  }

  if (!eligible.length) {
    $('#quizList').innerHTML = '<div class="empty">当前筛选范围没有题目。请至少选择一个章节和题型。</div>';
    $('#quizInfo').textContent = '当前筛选范围没有题目。';
    updateProgress();
    return;
  }

  count = Math.min(count, eligible.length);
  $('#countInput').value = count;
  state.quiz = sample(eligible, count);
  state.answered = {};
  const typeLabel = types.map((type) => TYPE_META[type]?.label || type).join('、');
  renderQuiz(`已生成 ${count} 道随机练习题：${typeLabel}。`);
}

function resetQuiz(updateText = true) {
  state.quiz = [];
  state.answered = {};
  if ($('#quizList')) $('#quizList').innerHTML = '';
  if ($('#quizInfo')) {
    $('#quizInfo').textContent = updateText ? '点击“期末模拟卷”或“随机练习”开始。' : `${state.subject.name} 已加载，可以开始组题。`;
  }
  updateProgress();
}

function renderQuiz(message) {
  if (!state.quiz.length) {
    $('#quizList').innerHTML = '';
    return;
  }
  $('#quizInfo').textContent = message;
  $('#quizList').innerHTML = state.quiz.map(renderQuestion).join('');
  updateProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderQuestion(question, index) {
  const meta = TYPE_META[question.type] || TYPE_META.short;
  const head = `
    <div class="q-head">
      <div class="q-meta">
        <span class="type-badge ${meta.className}">${meta.label}</span>
        <span class="score-badge">${question.score} 分</span>
        <span class="source">${escapeHtml(question.source)} · ${escapeHtml(question.section)}</span>
      </div>
    </div>
    <div class="q-title">${index + 1}. ${formatText(question.prompt)}</div>
  `;

  if (meta.objective) {
    return `
      <article class="card" id="card-${escapeHtml(question.id)}">
        ${head}
        ${renderObjectiveOptions(question)}
        <button class="btn btn-secondary" type="button" data-action="submit-objective" data-id="${escapeHtml(question.id)}">提交本题</button>
        <div class="result" id="res-${escapeHtml(question.id)}"></div>
      </article>
    `;
  }

  return `
    <article class="card" id="card-${escapeHtml(question.id)}">
      ${head}
      <button class="btn btn-secondary" type="button" data-action="reveal-subjective" data-id="${escapeHtml(question.id)}">显示参考答案</button>
      <div class="result neutral answer-panel" id="res-${escapeHtml(question.id)}"></div>
    </article>
  `;
}

function renderObjectiveOptions(question) {
  const inputType = question.type === 'multiple' ? 'checkbox' : 'radio';
  const options = question.options || (question.type === 'truefalse' ? ['正确', '错误'] : []);
  return `<div class="options">
    ${options.map((option, optionIndex) => `
      <label class="option">
        <input type="${inputType}" name="opt-${escapeHtml(question.id)}" value="${escapeHtml(option)}">
        <span><strong>${String.fromCharCode(65 + optionIndex)}.</strong> ${formatText(option)}</span>
      </label>
    `).join('')}
  </div>`;
}

function expectedAnswers(question) {
  return question.type === 'multiple' ? (question.answers || []) : [question.answer];
}

function selectedAnswers(question) {
  return $$(`input[name="opt-${CSS.escape(question.id)}"]:checked`).map((input) => input.value);
}

function sameSet(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function submitObjective(id) {
  const question = state.quiz.find((item) => item.id === id);
  const result = $(`#res-${CSS.escape(id)}`);
  const selected = selectedAnswers(question);

  if (!selected.length) {
    result.className = 'result neutral';
    result.innerHTML = '请先选择答案。';
    return;
  }

  const expected = expectedAnswers(question);
  const correct = sameSet([...selected].sort(), [...expected].sort());
  state.answered[id] = {
    objective: true,
    correct,
    earned: correct ? Number(question.score) : 0,
    possible: Number(question.score),
  };

  $$(`input[name="opt-${CSS.escape(id)}"]`).forEach((input) => {
    input.disabled = true;
  });

  result.className = `result ${correct ? 'ok' : 'bad'}`;
  result.innerHTML = `
    <strong>${correct ? '答对了。' : '答错了。'}</strong><br>
    <strong>正确答案：</strong>${formatText(expected.join('；'))}
    ${renderExplanation(question)}
  `;
  updateProgress();
}

function revealSubjective(id) {
  const question = state.quiz.find((item) => item.id === id);
  const result = $(`#res-${CSS.escape(id)}`);
  state.answered[id] = {
    objective: false,
    earned: 0,
    possible: Number(question.score),
  };
  result.className = 'result neutral answer-panel';
  result.innerHTML = `
    <strong>参考答案：</strong>${formatText(question.answer)}
    ${renderExplanation(question)}
  `;
  updateProgress();
}

function renderExplanation(question) {
  const explanation = question.explanation || question.knowledge;
  if (!explanation) return '';
  return `<div class="explanation"><strong>完整知识点 / 题解：</strong><br>${formatText(explanation)}</div>`;
}

function updateProgress() {
  if (!$('#progressBar')) return;
  const total = state.quiz.length;
  const done = Object.keys(state.answered).filter((id) => state.quiz.some((question) => question.id === id)).length;
  const objectiveTotal = state.quiz.filter((question) => TYPE_META[question.type]?.objective).reduce((sum, question) => sum + Number(question.score || 0), 0);
  const subjectiveTotal = state.quiz.filter((question) => !TYPE_META[question.type]?.objective).reduce((sum, question) => sum + Number(question.score || 0), 0);
  const earned = Object.values(state.answered).reduce((sum, item) => sum + Number(item.earned || 0), 0);

  $('#progressBar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  $('#scoreInfo').textContent = subjectiveTotal
    ? `客观题：${earned} / ${objectiveTotal}；主观题：${subjectiveTotal} 分自评`
    : `得分：${earned} / ${objectiveTotal}`;
}

function renderKnowledgeBase() {
  if (!$('#kbList')) return;
  const keyword = $('#kbSearch').value.trim().toLowerCase();
  const type = $('#kbType').value;
  const section = $('#kbSection').value;
  const list = state.questions.filter((question) => {
    const typeMatches = type === 'all' || question.type === type;
    const sectionMatches = section === 'all' || question.section === section;
    const haystack = [
      question.prompt,
      question.answer,
      (question.answers || []).join(' '),
      question.explanation,
      question.knowledge,
      question.section,
      question.source,
    ].join('\n').toLowerCase();
    return typeMatches && sectionMatches && (!keyword || haystack.includes(keyword));
  });

  $('#kbStats').textContent = `当前显示 ${list.length} / ${state.questions.length} 项。`;
  $('#kbList').innerHTML = list.map(renderKnowledgeCard).join('') || '<div class="empty">没有匹配结果。</div>';
}

function renderKnowledgeCard(question) {
  const meta = TYPE_META[question.type] || TYPE_META.short;
  const answer = question.type === 'multiple' ? (question.answers || []).join('；') : question.answer;
  return `
    <article class="kb-card" id="kb-${escapeHtml(question.id)}">
      <div class="q-meta">
        <span class="type-badge ${meta.className}">${meta.label}</span>
        <span class="source">${escapeHtml(question.source)} · ${escapeHtml(question.section)}</span>
      </div>
      <h3>${formatText(question.prompt)}</h3>
      ${question.options?.length ? `<div class="kb-options">${question.options.map((option, index) => `<div>${String.fromCharCode(65 + index)}. ${formatText(option)}</div>`).join('')}</div>` : ''}
      <div class="kb-answer"><strong>答案：</strong>${formatText(answer)}</div>
      ${question.explanation ? `<div class="kb-answer"><strong>题解：</strong>${formatText(question.explanation)}</div>` : ''}
    </article>
  `;
}

init();
