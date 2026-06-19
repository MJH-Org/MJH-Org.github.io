const state = {
  subjects: [],
  subject: null,
  questions: [],
  raw: '',
  quiz: [],
  options: {},
  answered: {},
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

function getSectionNames() {
  return [...new Set(state.questions.map((item) => item.section))];
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function setupHeaderAutoHide() {
  const header = $('.app-header');
  let lastY = window.scrollY || 0;
  let ticking = false;
  const threshold = 10;

  function apply() {
    const y = window.scrollY || 0;
    const delta = y - lastY;

    if (y <= 8) {
      header.classList.remove('header-hidden');
    } else if (delta > threshold) {
      header.classList.add('header-hidden');
      lastY = y;
    } else if (delta < -threshold) {
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
  bindEvents();
  setupHeaderAutoHide();

  try {
    state.subjects = await fetchJson('/api/subjects');
    renderSubjectOptions();
    if (state.subjects.length) {
      await loadSubject(state.subjects[0].id);
    } else {
      $('#quizInfo').textContent = '还没有可用学科。';
    }
  } catch (error) {
    console.error(error);
    $('#quizInfo').textContent = '题库加载失败，请检查 API 服务。';
    $('#kbList').innerHTML = '<div class="empty">题库加载失败。</div>';
  }
}

function bindEvents() {
  $('#subjectSelect').addEventListener('change', (event) => loadSubject(event.target.value));
  $('#generateBtn').addEventListener('click', generateQuiz);
  $('#resetBtn').addEventListener('click', resetQuiz);
  $('#kbSearch').addEventListener('input', renderKnowledgeBase);
  $('#kbType').addEventListener('change', renderKnowledgeBase);
  $('#kbSection').addEventListener('change', renderKnowledgeBase);

  $$('.tab-btn').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  $('#quizList').addEventListener('click', (event) => {
    const submitButton = event.target.closest('[data-action="submit-choice"]');
    if (submitButton) {
      submitChoice(submitButton.dataset.id);
      return;
    }

    const answerMask = event.target.closest('[data-action="reveal-short"]');
    if (answerMask) {
      revealShort(answerMask, answerMask.dataset.id);
      return;
    }

    const kbButton = event.target.closest('[data-action="go-kb"]');
    if (kbButton) {
      goKnowledgeBase(kbButton.dataset.id);
    }
  });
}

function renderSubjectOptions() {
  $('#subjectSelect').innerHTML = state.subjects
    .map((subject) => `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.name)}</option>`)
    .join('');
}

async function loadSubject(subjectId) {
  const subject = state.subjects.find((item) => item.id === subjectId);
  if (!subject) {
    return;
  }

  state.subject = subject;
  $('#subjectSelect').value = subjectId;
  $('#quizInfo').textContent = '正在加载题库...';

  const [questions, rawPayload] = await Promise.all([
    fetchJson(`/api/subjects/${encodeURIComponent(subjectId)}/questions`),
    fetchJson(`/api/subjects/${encodeURIComponent(subjectId)}/raw`),
  ]);

  state.questions = questions;
  state.raw = rawPayload.text || '';
  state.quiz = [];
  state.options = {};
  state.answered = {};

  renderStats();
  renderSectionFilters();
  renderKnowledgeFilters();
  renderKnowledgeBase();
  resetQuiz(false);
  $('#rawSource').textContent = state.raw;
}

function renderStats() {
  $('#totalCount').textContent = state.questions.length;
  $('#choiceCount').textContent = state.questions.filter((item) => item.type === 'choice').length;
  $('#shortCount').textContent = state.questions.filter((item) => item.type === 'short').length;
  $('#coverageCount').textContent = state.subject?.coverageLabel || `${state.questions.length}/${state.questions.length}`;
}

function renderSectionFilters() {
  $('#sectionChecks').innerHTML = getSectionNames()
    .map((section) => `
      <label class="check-pill">
        <input type="checkbox" value="${escapeHtml(section)}" checked>
        <span>${escapeHtml(section)}</span>
      </label>
    `)
    .join('');
}

function renderKnowledgeFilters() {
  $('#kbSection').innerHTML = '<option value="all">全部章节</option>'
    + getSectionNames()
      .map((section) => `<option value="${escapeHtml(section)}">${escapeHtml(section)}</option>`)
      .join('');
}

function getEnabledSections() {
  return $$('#sectionChecks input:checked').map((input) => input.value);
}

function getEligibleQuestions() {
  const type = $('#typeSelect').value;
  const enabledSections = getEnabledSections();

  return state.questions.filter((question) => {
    const typeMatches = type === 'all' || question.type === type;
    const sectionMatches = enabledSections.includes(question.section);
    return typeMatches && sectionMatches;
  });
}

function generateQuiz() {
  const eligible = getEligibleQuestions();
  let count = Math.max(1, Number.parseInt($('#countInput').value || '1', 10));

  if (!eligible.length) {
    $('#quizList').innerHTML = '<div class="empty">当前筛选范围没有题目。请至少选择一个章节。</div>';
    $('#quizInfo').textContent = '当前筛选范围没有题目。';
    updateProgress();
    return;
  }

  count = Math.min(count, eligible.length);
  $('#countInput').value = count;
  state.quiz = sample(eligible, count);
  state.options = {};
  state.answered = {};
  renderQuiz();
  updateProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetQuiz(updateText = true) {
  state.quiz = [];
  state.options = {};
  state.answered = {};
  $('#quizList').innerHTML = '';
  if (updateText) {
    $('#quizInfo').textContent = '设置数量后点击“随机组题”。';
  } else {
    $('#quizInfo').textContent = `${state.subject.name} 已加载，可以开始组题。`;
  }
  updateProgress();
}

function makeOptions(question) {
  if (state.options[question.id]) {
    return state.options[question.id];
  }

  const pool = state.questions
    .filter((item) => item.type === 'choice' && item.id !== question.id)
    .map((item) => item.answer);
  const distinct = [...new Set(pool)].filter((answer) => answer && answer !== question.answer);
  const options = shuffle([question.answer, ...sample(distinct, 3)]);
  state.options[question.id] = options;
  return options;
}

function renderQuiz() {
  if (!state.quiz.length) {
    $('#quizList').innerHTML = '';
    return;
  }

  $('#quizInfo').textContent = `本组 ${state.quiz.length} 题。选择题提交后判分，简答题用于自查背诵。`;
  $('#quizList').innerHTML = state.quiz
    .map((question, index) => (question.type === 'choice'
      ? renderChoice(question, index)
      : renderShort(question, index)))
    .join('');
}

function renderQuestionHead(question, index) {
  const typeName = question.type === 'choice' ? '选择题' : '简答题';
  const typeClass = question.type === 'choice' ? 'type-choice' : 'type-short';

  return `
    <div class="q-head">
      <div class="q-meta">
        <span class="type-badge ${typeClass}">${typeName}</span>
        <span class="source">${escapeHtml(question.source)} · ${escapeHtml(question.section)}</span>
      </div>
      <button class="kb-link" type="button" data-action="go-kb" data-id="${escapeHtml(question.id)}">查完整知识库</button>
    </div>
    <div class="q-title">${index + 1}. ${formatText(question.prompt)}</div>
  `;
}

function renderChoice(question, index) {
  const options = makeOptions(question)
    .map((option, optionIndex) => `
      <label class="option">
        <input type="radio" name="opt-${escapeHtml(question.id)}" value="${escapeHtml(option)}">
        <span><strong>${String.fromCharCode(65 + optionIndex)}.</strong> ${formatText(option)}</span>
      </label>
    `)
    .join('');

  return `
    <article class="card" id="card-${escapeHtml(question.id)}">
      ${renderQuestionHead(question, index)}
      <div class="options">${options}</div>
      <button class="btn btn-secondary" type="button" data-action="submit-choice" data-id="${escapeHtml(question.id)}">提交本题</button>
      <div class="result" id="res-${escapeHtml(question.id)}"></div>
    </article>
  `;
}

function renderShort(question, index) {
  return `
    <article class="card" id="card-${escapeHtml(question.id)}">
      ${renderQuestionHead(question, index)}
      <div class="answer-mask masked" data-action="reveal-short" data-id="${escapeHtml(question.id)}">
        <div class="answer-content">${formatText(question.answer)}</div>
      </div>
      <div class="result neutral">提示：先自己口述答案，再点击黑色遮罩核对。</div>
    </article>
  `;
}

function submitChoice(id) {
  const question = state.questions.find((item) => item.id === id);
  const picked = $(`input[name="opt-${CSS.escape(id)}"]:checked`);
  const result = $(`#res-${CSS.escape(id)}`);

  if (!picked) {
    result.className = 'result neutral';
    result.innerHTML = '请先选择一个选项。';
    return;
  }

  const correct = picked.value === question.answer;
  state.answered[id] = { type: 'choice', correct };
  $$(`input[name="opt-${CSS.escape(id)}"]`).forEach((input) => {
    input.disabled = true;
  });
  result.className = `result ${correct ? 'ok' : 'bad'}`;
  result.innerHTML = `
    ${correct ? '答对了。' : '答错了。'}<br>
    <strong>正确答案：</strong>${formatText(question.answer)}<br>
    <button class="kb-link" type="button" data-action="go-kb" data-id="${escapeHtml(question.id)}">查看对应完整知识点</button>
  `;
  updateProgress();
}

function revealShort(element, id) {
  if (!element.classList.contains('masked')) {
    return;
  }

  element.classList.remove('masked');
  element.classList.add('revealed');
  state.answered[id] = { type: 'short', correct: null };
  updateProgress();
}

function updateProgress() {
  const total = state.quiz.length;
  const done = Object.keys(state.answered).filter((id) => state.quiz.some((question) => question.id === id)).length;
  const choiceCount = state.quiz.filter((question) => question.type === 'choice').length;
  const correct = Object.entries(state.answered)
    .filter(([id, value]) => value.type === 'choice' && value.correct && state.quiz.some((question) => question.id === id))
    .length;

  $('#progressBar').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  $('#scoreInfo').textContent = `得分：${correct} / ${choiceCount}`;
}

function switchTab(tab) {
  $$('.tab-btn').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  $('#kbTab').hidden = tab !== 'kb';
  $('#rawTab').hidden = tab !== 'raw';
}

function renderKnowledgeBase() {
  const keyword = $('#kbSearch').value.trim().toLowerCase();
  const type = $('#kbType').value;
  const section = $('#kbSection').value;
  const list = state.questions.filter((question) => {
    const typeMatches = type === 'all' || question.type === type;
    const sectionMatches = section === 'all' || question.section === section;
    const haystack = [
      question.prompt,
      question.answer,
      question.knowledge,
      question.section,
      question.source,
    ].join('\n').toLowerCase();
    const keywordMatches = !keyword || haystack.includes(keyword);
    return typeMatches && sectionMatches && keywordMatches;
  });

  $('#kbStats').textContent = `当前显示 ${list.length} / ${state.questions.length} 项。`;
  $('#kbList').innerHTML = list.map(renderKnowledgeCard).join('') || '<div class="empty">没有匹配结果。</div>';
}

function renderKnowledgeCard(question) {
  return `
    <article class="kb-card" id="kb-${escapeHtml(question.id)}">
      <div class="q-meta">
        <span class="type-badge ${question.type === 'choice' ? 'type-choice' : 'type-short'}">${question.type === 'choice' ? '选择题' : '简答题'}</span>
        <span class="source">${escapeHtml(question.source)} · ${escapeHtml(question.section)}</span>
      </div>
      <h3>${formatText(question.prompt)}</h3>
      <div class="kb-answer">${formatText(question.answer)}</div>
    </article>
  `;
}

function goKnowledgeBase(id) {
  switchTab('kb');
  $('#kbSearch').value = '';
  $('#kbType').value = 'all';
  $('#kbSection').value = 'all';
  renderKnowledgeBase();

  window.setTimeout(() => {
    const element = $(`#kb-${CSS.escape(id)}`);
    if (!element) {
      return;
    }

    $$('.kb-card.highlight').forEach((item) => item.classList.remove('highlight'));
    element.classList.add('highlight');
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.setTimeout(() => element.classList.remove('highlight'), 1800);
  }, 50);
}

init();
