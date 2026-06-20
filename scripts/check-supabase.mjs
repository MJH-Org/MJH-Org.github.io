import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('.');
const configCandidates = [
  resolve(root, 'frontend/supabase-config.local.js'),
  resolve(root, 'frontend/supabase-config.js'),
];

function mask(value) {
  if (!value) return '';
  if (value.length <= 14) return `${value.slice(0, 4)}...`;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

async function readConfig() {
  for (const filePath of configCandidates) {
    try {
      const source = await readFile(filePath, 'utf8');
      const url = source.match(/url:\s*['"]([^'"]+)['"]/)?.[1]?.trim() || '';
      const anonKey = source.match(/anonKey:\s*['"]([^'"]+)['"]/)?.[1]?.trim() || '';
      if (url || anonKey) return { filePath, url, anonKey };
    } catch {
      // Try the next candidate.
    }
  }
  return { filePath: '', url: '', anonKey: '' };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function printResult(label, ok, detail = '') {
  const icon = ok ? 'OK' : 'FAIL';
  console.log(`${icon} ${label}${detail ? ` - ${detail}` : ''}`);
}

const { filePath, url, anonKey } = await readConfig();
let failed = false;

const validUrl = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url);
const validKey = /^(sb_publishable_|eyJ)/.test(anonKey);

printResult('config file', Boolean(filePath), filePath || 'no Supabase config found');
printResult('project url', validUrl, url || 'missing');
printResult('publishable/anon key', validKey, anonKey ? mask(anonKey) : 'missing');

if (!filePath || !validUrl || !validKey) {
  console.log('\nFill frontend/supabase-config.local.js for local testing.');
  process.exit(1);
}

try {
  const { response, body } = await fetchJson(`${url}/auth/v1/settings`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
  });
  const ok = response.ok;
  printResult('auth endpoint', ok, `${response.status} ${response.statusText}`);
  if (!ok) {
    failed = true;
    console.log(body);
  }
} catch (error) {
  failed = true;
  printResult('auth endpoint', false, error.message);
}

try {
  const tableUrl = `${url}/rest/v1/user_question_marks?select=subject_id,question_id,mark_type&limit=1`;
  const { response, body } = await fetchJson(tableUrl, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: 'application/json',
    },
  });

  if (response.ok) {
    printResult('user_question_marks table', true, 'REST endpoint reachable');
  } else {
    const message = typeof body === 'object' && body ? `${body.code || response.status}: ${body.message || response.statusText}` : String(body || response.statusText);
    const relationMissing = /does not exist|relation .* not found|PGRST205|42P01/i.test(message);
    if (relationMissing) {
      failed = true;
      printResult('user_question_marks table', false, `${message}. Run supabase/schema.sql in SQL Editor.`);
    } else {
      printResult('user_question_marks table', true, `${response.status}; table endpoint responded (${message})`);
    }
  }
} catch (error) {
  failed = true;
  printResult('user_question_marks table', false, error.message);
}

if (failed) process.exit(1);
console.log('\nSupabase basic check finished. Full sync still needs browser login with a real email.');
