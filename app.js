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
const MARK_TYPES = {
  easy: { label: '简单题', actionLabel: '标记简单', activeLabel: '已标简单' },
};
const LOCAL_MARKS_KEY = 'tiku:user-question-marks:v1';

const state = {
  page: document.body.dataset.page || 'quiz',
  subjects: [],
  subject: null,
  questions: [],
  sourceItems: [],
  raw: '',
  quiz: [],
  answered: {},
  apiMode: true,
  marks: new Set(),
  marksLoading: false,
  pendingMarks: new Set(),
  auth: {
    enabled: false,
    ready: false,
    client: null,
    user: null,
    message: '',
  },
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

function getSupabaseConfig() {
  const config = window.TIKU_SUPABASE || {};
  const url = String(config.url || '').trim();
  const anonKey = String(config.anonKey || '').trim();
  return {
    url,
    anonKey,
    enabled: /^https:\/\/.+\.supabase\.co$/i.test(url) && anonKey.length > 20,
  };
}

function currentSubjectId() {
  return state.subject?.id || '';
}

function markKey(subjectId, questionId, markType = 'easy') {
  return `${subjectId}::${questionId}::${markType}`;
}

function parseMarkKey(key) {
  const [subjectId, questionId, markType] = String(key).split('::');
  return { subjectId, questionId, markType };
}

function readLocalMarks() {
  try {
    const raw = window.localStorage.getItem(LOCAL_MARKS_KEY);
    const items = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(items)) return new Set();
    return new Set(items.filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeLocalMarks(keys) {
  try {
    window.localStorage.setItem(LOCAL_MARKS_KEY, JSON.stringify([...keys].sort()));
  } catch (error) {
    console.warn('Unable to persist local marks', error);
  }
}

function loadLocalMarksIntoState() {
  state.marks = readLocalMarks();
}

function hasMark(questionId, markType = 'easy') {
  if (!currentSubjectId()) return false;
  return state.marks.has(markKey(currentSubjectId(), questionId, markType));
}

function getEasyCount() {
  if (!currentSubjectId()) return 0;
  const prefix = `${currentSubjectId()}::`;
  return [...state.marks].filter((key) => key.startsWith(prefix) && key.endsWith('::easy')).length;
}

function updateEasyCount() {
  const count = $('#easyCount');
  if (count) count.textContent = getEasyCount();
}

function shouldExcludeEasy() {
  return Boolean($('#excludeEasy')?.checked);
}

async function setupSupabase() {
  loadLocalMarksIntoState();
  const config = getSupabaseConfig();

  if (!config.enabled) {
    state.auth.ready = true;
    state.auth.enabled = false;
    state.auth.message = '本地标记模式';
    renderAuthPanel();
    updateEasyCount();
    return;
  }

  state.auth.enabled = true;
  state.auth.message = '正在连接账户...';
  renderAuthPanel();

  try {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    state.auth.client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    const { data, error } = await state.auth.client.auth.getSession();
    if (error) throw error;
    state.auth.user = data.session?.user || null;
    state.auth.ready = true;
    state.auth.message = state.auth.user ? '账户已连接' : '可登录同步标记';

    state.auth.client.auth.onAuthStateChange(async (_event, session) => {
      state.auth.user = session?.user || null;
      state.auth.message = state.auth.user ? '账户已连接' : '可登录同步标记';
      if (state.auth.user) {
        await syncLocalMarksToRemote();
        await loadRemoteMarks();
      } else {
        loadLocalMarksIntoState();
      }
      renderAuthPanel();
      refreshRenderedMarks();
    });

    if (state.auth.user) {
      await syncLocalMarksToRemote();
      await loadRemoteMarks();
    }
  } catch (error) {
    console.error(error);
    state.auth.enabled = false;
    state.auth.ready = true;
    state.auth.client = null;
    state.auth.user = null;
    state.auth.message = '账户连接失败，已使用本地标记';
  }

  renderAuthPanel();
  updateEasyCount();
}

async function loadRemoteMarks() {
  if (!state.auth.client || !state.auth.user) return;
  state.marksLoading = true;
  try {
    const { data, error } = await state.auth.client
      .from('user_question_marks')
      .select('subject_id, question_id, mark_type')
      .eq('mark_type', 'easy');
    if (error) throw error;

    state.marks = new Set((data || []).map((item) => markKey(item.subject_id, item.question_id, item.mark_type)));
    writeLocalMarks(state.marks);
  } catch (error) {
    console.error(error);
    state.auth.message = '云端标记加载失败，暂用本地记录';
    loadLocalMarksIntoState();
  } finally {
    state.marksLoading = false;
    updateEasyCount();
  }
}

async function syncLocalMarksToRemote() {
  if (!state.auth.client || !state.auth.user) return;
  const localMarks = [...readLocalMarks()].map(parseMarkKey)
    .filter((item) => item.subjectId && item.questionId && item.markType === 'easy')
    .map((item) => ({
      user_id: state.auth.user.id,
      subject_id: item.subjectId,
      question_id: item.questionId,
      mark_type: item.markType,
      updated_at: new Date().toISOString(),
    }));

  if (!localMarks.length) return;
  const { error } = await state.auth.client
    .from('user_question_marks')
    .upsert(localMarks, { onConflict: 'user_id,subject_id,question_id,mark_type' });
  if (error) console.error(error);
}

async function setQuestionMark(questionId, markType, enabled) {
  if (!currentSubjectId()) return;
  const key = markKey(currentSubjectId(), questionId, markType);
  state.pendingMarks.add(key);
  refreshRenderedMarks(questionId);

  if (enabled) state.marks.add(key);
  else state.marks.delete(key);
  writeLocalMarks(state.marks);
  refreshRenderedMarks(questionId);

  if (!state.auth.client || !state.auth.user) {
    state.pendingMarks.delete(key);
    refreshRenderedMarks(questionId);
    return;
  }

  try {
    if (enabled) {
      const { error } = await state.auth.client.from('user_question_marks').upsert({
        user_id: state.auth.user.id,
        subject_id: currentSubjectId(),
        question_id: questionId,
        mark_type: markType,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,subject_id,question_id,mark_type' });
      if (error) throw error;
    } else {
      const { error } = await state.auth.client
        .from('user_question_marks')
        .delete()
        .eq('user_id', state.auth.user.id)
        .eq('subject_id', currentSubjectId())
        .eq('question_id', questionId)
        .eq('mark_type', markType);
      if (error) throw error;
    }
    state.auth.message = '标记已同步';
  } catch (error) {
    console.error(error);
    state.auth.message = '云端同步失败，本地已保存';
  } finally {
    state.pendingMarks.delete(key);
    refreshRenderedMarks(questionId);
    renderAuthPanel();
  }
}

async function signInWithEmail() {
  const email = $('#authEmail')?.value.trim();
  if (!email || !state.auth.client) return;

  state.auth.message = '正在发送登录邮件...';
  renderAuthPanel();

  const redirectTo = window.location.href.split('#')[0];
  const { error } = await state.auth.client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });

  state.auth.message = error ? `发送失败：${error.message}` : '登录邮件已发送，请查收邮箱';
  renderAuthPanel();
}

async function signOut() {
  if (!state.auth.client) return;
  await state.auth.client.auth.signOut();
}

function renderAuthPanel() {
  const panel = $('#authPanel');
  if (!panel) return;

  if (!state.auth.enabled) {
    panel.innerHTML = `
      <div class="auth-box">
        <div class="auth-status">${escapeHtml(state.auth.message || '本地标记模式')}</div>
      </div>
    `;
    return;
  }

  if (state.auth.user) {
    const email = state.auth.user.email || '已登录';
    panel.innerHTML = `
      <div class="auth-box">
        <div class="auth-user">
          <span class="auth-status">${escapeHtml(email)}</span>
          <button class="btn btn-ghost btn-small" type="button" data-action="sign-out">退出</button>
        </div>
        <div class="auth-status">${escapeHtml(state.auth.message || '账户已连接')}</div>
      </div>
    `;
    return;
  }

  panel.innerHTML = `
    <div class="auth-box">
      <div class="auth-form">
        <input id="authEmail" type="email" autocomplete="email" placeholder="邮箱登录">
        <button class="btn btn-secondary btn-small" type="button" data-action="sign-in">发送</button>
      </div>
      <div class="auth-status">${escapeHtml(state.auth.message || '登录后同步简单题标记')}</div>
    </div>
  `;
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

async function loadSubjectSource(subject) {
  if (state.apiMode) {
    return fetchJson(`/api/subjects/${encodeURIComponent(subject.id)}/source`);
  }
  return subject.sourceQuestionFile ? fetchJson(`data/${subject.sourceQuestionFile}`) : [];
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
  await setupSupabase();

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
  $('#typeDropdownBtn')?.addEventListener('click', toggleTypeDropdown);
  $('#typeChecks')?.addEventListener('change', updateTypeSummary);
  $('#excludeEasy')?.addEventListener('change', () => {
    if (!shouldExcludeEasy() || !state.quiz.length) return;
    const nextQuiz = state.quiz.filter((question) => !hasMark(question.id, 'easy'));
    if (nextQuiz.length !== state.quiz.length) {
      state.quiz = nextQuiz;
      renderQuiz('已排除当前题单中的简单题。');
    }
  });

  document.addEventListener('click', (event) => {
    const dropdown = $('#typeDropdown');
    if (dropdown && !dropdown.contains(event.target)) closeTypeDropdown();

    const signInButton = event.target.closest('[data-action="sign-in"]');
    if (signInButton) {
      signInWithEmail();
      return;
    }

    const signOutButton = event.target.closest('[data-action="sign-out"]');
    if (signOutButton) {
      signOut();
      return;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTypeDropdown();
    if (event.key === 'Enter' && event.target?.id === 'authEmail') {
      event.preventDefault();
      signInWithEmail();
    }
  });

  $('#quizList')?.addEventListener('click', (event) => {
    const submitButton = event.target.closest('[data-action="submit-objective"]');
    if (submitButton) {
      submitObjective(submitButton.dataset.id);
      return;
    }

    const revealButton = event.target.closest('[data-action="reveal-subjective"]');
    if (revealButton) {
      revealSubjective(revealButton.dataset.id);
      return;
    }

    const markButton = event.target.closest('[data-action="toggle-mark"]');
    if (markButton) {
      toggleQuestionMark(markButton.dataset.id, markButton.dataset.mark);
    }
  });

  $('#kbList')?.addEventListener('click', (event) => {
    const markButton = event.target.closest('[data-action="toggle-mark"]');
    if (markButton) {
      toggleQuestionMark(markButton.dataset.id, markButton.dataset.mark);
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

  const [questions, sourceItems, rawText] = await Promise.all([
    loadSubjectQuestions(subject),
    loadSubjectSource(subject),
    loadSubjectRaw(subject),
  ]);

  state.questions = questions;
  state.sourceItems = sourceItems;
  state.raw = rawText;
  state.quiz = [];
  state.answered = {};
  updateEasyCount();

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
  updateTypeSummary();
}

function toggleTypeDropdown() {
  const dropdown = $('#typeDropdown');
  const button = $('#typeDropdownBtn');
  if (!dropdown || !button) return;
  const nextOpen = !dropdown.classList.contains('open');
  dropdown.classList.toggle('open', nextOpen);
  button.setAttribute('aria-expanded', String(nextOpen));
}

function closeTypeDropdown() {
  const dropdown = $('#typeDropdown');
  const button = $('#typeDropdownBtn');
  if (!dropdown || !button) return;
  dropdown.classList.remove('open');
  button.setAttribute('aria-expanded', 'false');
}

function updateTypeSummary() {
  const summary = $('#typeSummary');
  if (!summary) return;
  const checked = getEnabledPracticeTypes();
  const enabled = $$('#typeChecks input:not(:disabled)').map((input) => input.value);
  if (!checked.length) {
    summary.textContent = '请选择题型';
  } else if (checked.length === enabled.length) {
    summary.textContent = '全部题型';
  } else {
    summary.textContent = checked.map((type) => TYPE_META[type]?.label || type).join('、');
  }
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
  return state.sourceItems.map((item, index) => ({
    ...item,
    key: item.id || `source-${index}`,
    label: item.type === 'choice' ? '客观知识点' : '问答题',
    title: item.type === 'choice' ? item.source : item.prompt,
    body: item.type === 'choice' ? item.knowledge : `${item.prompt}\n${item.answer}`,
  }));
}

function renderSourceFilters() {
  const select = $('#sourceSection');
  if (!select) return;
  const sections = [...new Set(parseSourceSections().map((item) => item.section))];
  select.innerHTML = '<option value="all">全部资料</option>'
    + sections.map((section) => `<option value="${escapeHtml(section)}">${escapeHtml(section)}</option>`).join('');
}

function renderSourceViewer() {
  if (!$('#sourceList')) return;
  const keyword = $('#sourceSearch')?.value.trim().toLowerCase() || '';
  const sectionKey = $('#sourceSection')?.value || 'all';
  const items = parseSourceSections();
  const list = items.filter((item) => {
    const sectionMatches = sectionKey === 'all' || item.section === sectionKey;
    const haystack = [
      item.label,
      item.title,
      item.body,
      item.answer,
      item.prompt,
      item.source,
      item.section,
    ].join('\n').toLowerCase();
    return sectionMatches && (!keyword || haystack.includes(keyword));
  });

  $('#sourceStats').textContent = `当前显示 ${list.length} / ${items.length} 条资料。`;
  $('#sourceList').innerHTML = list.map((item) => `
    <article class="source-card" id="source-${escapeHtml(item.key)}">
      <div class="q-meta">
        <span class="type-badge ${item.type === 'choice' ? 'type-single' : 'type-short'}">${escapeHtml(item.label)}</span>
        <span class="source">${escapeHtml(item.source)} · ${escapeHtml(item.section)}</span>
      </div>
      <h2>${formatText(item.title)}</h2>
      <div class="source-text">${formatText(item.body)}</div>
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
    const markMatches = !shouldExcludeEasy() || !hasMark(question.id, 'easy');
    return typeMatches && sectionMatches && markMatches;
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

function renderMarkButton(questionId, markType = 'easy') {
  const mark = MARK_TYPES[markType];
  const active = hasMark(questionId, markType);
  return `
    <button
      class="mark-btn ${active ? 'is-active' : ''}"
      type="button"
      data-action="toggle-mark"
      data-id="${escapeHtml(questionId)}"
      data-mark="${escapeHtml(markType)}"
      aria-pressed="${active ? 'true' : 'false'}">
      ${escapeHtml(active ? mark.activeLabel : mark.actionLabel)}
    </button>
  `;
}

async function toggleQuestionMark(questionId, markType = 'easy') {
  if (!questionId || !MARK_TYPES[markType]) return;
  await setQuestionMark(questionId, markType, !hasMark(questionId, markType));
}

function refreshRenderedMarks(questionId = '') {
  updateEasyCount();
  const selector = questionId
    ? `[data-action="toggle-mark"][data-id="${CSS.escape(questionId)}"]`
    : '[data-action="toggle-mark"]';

  $$(selector).forEach((button) => {
    const markType = button.dataset.mark || 'easy';
    const mark = MARK_TYPES[markType];
    const active = hasMark(button.dataset.id, markType);
    const pending = state.pendingMarks.has(markKey(currentSubjectId(), button.dataset.id, markType));
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = pending;
    button.textContent = pending ? '同步中...' : (active ? mark.activeLabel : mark.actionLabel);
  });

  if ($('#kbList')) renderKnowledgeBase();
  if (shouldExcludeEasy() && state.quiz.some((question) => question.id === questionId)) {
    state.quiz = state.quiz.filter((question) => !hasMark(question.id, 'easy'));
    renderQuiz('已排除刚标记的简单题。');
  }
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
      <div class="q-actions">${renderMarkButton(question.id, 'easy')}</div>
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
      <div class="kb-headline">
        <h3>${formatText(question.prompt)}</h3>
        ${renderMarkButton(question.id, 'easy')}
      </div>
      ${question.options?.length ? `<div class="kb-options">${question.options.map((option, index) => `<div>${String.fromCharCode(65 + index)}. ${formatText(option)}</div>`).join('')}</div>` : ''}
      <div class="kb-answer"><strong>答案：</strong>${formatText(answer)}</div>
      ${question.explanation ? `<div class="kb-answer"><strong>题解：</strong>${formatText(question.explanation)}</div>` : ''}
    </article>
  `;
}

init();
