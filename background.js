import {
  getFile, saveFile, notePath, solutionPath, testConnection,
  getUser, createRepo, noteCommitDates, listNoteSlugs,
  branchExists, defaultBranch, deleteFile,
  computeStreak, localDateKey, splitFrontmatter, joinFrontmatter,
  getReviews, updateReviews, nextReview, addDays, daysBetween, FIRST_INTERVAL,
} from './github.js';
import { requestDeviceCode, pollForToken, signOut } from './auth.js';

const CONFIG_KEYS = ['ghToken', 'ghOwner', 'ghRepo', 'ghBranch', 'notesDir', 'solutionsDir'];

async function loadConfig() {
  const data = await chrome.storage.local.get(CONFIG_KEYS);
  if (!data.ghToken || !data.ghOwner || !data.ghRepo) return null;
  return {
    token: data.ghToken,
    owner: data.ghOwner,
    repo: data.ghRepo,
    branch: data.ghBranch || 'main',
    notesDir: data.notesDir || 'notes',
    solutionsDir: data.solutionsDir || 'solutions',
  };
}

async function loadToken() {
  const { ghToken } = await chrome.storage.local.get('ghToken');
  return ghToken ? { token: ghToken } : null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then(sendResponse)
    .catch(async (e) => sendResponse(await explain(e)));
  return true;
});

async function explain(e) {
  const message = e?.message || String(e);

  if (/auth failed|bad credentials|401/i.test(message)) {
    return { error: 'GitHub sign-in expired — sign in again in settings', authFailed: true };
  }

  if (/not found|404/i.test(message)) {
    const config = await loadConfig();
    if (config) {
      try {
        if (!(await branchExists(config, config.branch))) {
          const real = await defaultBranch(config);
          return {
            error: real
              ? `branch "${config.branch}" doesn't exist — this repo uses "${real}"`
              : `branch "${config.branch}" doesn't exist in ${config.owner}/${config.repo}`,
            badBranch: true,
          };
        }
      } catch {  }
    }
  }

  return { error: message };
}

async function handle(msg) {
  switch (msg.type) {
    case 'LOAD_NOTE': return loadNote(msg);
    case 'SAVE_NOTE': return saveNote(msg);
    case 'NOTE_FILE': return noteFile(msg);
    case 'SAVE_SOLUTION': return saveSolution(msg);
    case 'DUE_REVIEWS': return dueReviews();
    case 'RATE': return rateReview(msg);
    case 'STREAK': return getStreak();
    case 'LIST_NOTES': return listNotes();
    case 'DELETE_NOTE': return deleteNote(msg);
    case 'TEST_CONNECTION': return testConnection(msg.config);
    case 'OPEN_OPTIONS': chrome.runtime.openOptionsPage(); return { ok: true };

    case 'AUTH_STATUS': return authStatus();
    case 'AUTH_START': return authStart();
    case 'AUTH_POLL': return authPoll(msg.deviceCode);
    case 'AUTH_SIGNOUT': await signOut(); return { ok: true };

    case 'CREATE_REPO': return createRepoForUi(msg.name);
    case 'SET_REPO': return setRepo(msg);

    default: return { error: `unknown message type: ${msg.type}` };
  }
}

async function unconfigured() {
  return { configured: false, signedIn: !!(await loadToken()) };
}

async function loadNote(msg) {
  const config = await loadConfig();
  if (!config) return unconfigured();
  const path = notePath(config, msg.slug);
  // a broken reviews.json must never stop a note from loading
  const [file, reviews] = await Promise.all([getFile(config, path), getReviews(config).catch(() => ({}))]);
  const review = reviews[msg.slug] || null;
  return {
    configured: true,
    path,
    repo: `${config.owner}/${config.repo}`,
    streak: await getStreak(),
    content: file ? splitFrontmatter(file.content).body : '',
    sha: file ? file.sha : null,
    review,
    reviewDue: !!file && (!review || review.due <= localDateKey(new Date())),
  };
}

// The note as it's committed. Re-reads the file so keys edited on GitHub survive.
async function withFrontmatter(config, msg) {
  const today = localDateKey(new Date());
  const existing = config && msg.sha ? await getFile(config, notePath(config, msg.slug)) : null;
  const { entries } = splitFrontmatter(existing?.content || '');
  const created = entries.find((e) => e.key === 'created')?.lines[0].match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const meta = msg.meta || {};
  return joinFrontmatter(entries, {
    number: meta.number,
    title: meta.title,
    difficulty: meta.difficulty,
    tags: meta.tags,
    url: `https://leetcode.com/problems/${msg.slug}/`,
    created: msg.sha ? created : today,
    updated: today,
  }, msg.content);
}

// Download works signed out or offline too, just without the keys only GitHub has.
async function noteFile(msg) {
  const config = await loadConfig();
  return { content: await withFrontmatter(config, msg).catch(() => withFrontmatter(null, msg)) };
}

async function saveNote(msg) {
  const config = await loadConfig();
  if (!config) return unconfigured();
  const path = notePath(config, msg.slug);
  const message = `notes: ${msg.title || msg.slug}`;
  const content = await withFrontmatter(config, msg);

  let sha;
  try {
    sha = await saveFile(config, path, content, msg.sha, message);
  } catch (e) {
    if (!/conflict|409|422/i.test(e.message)) throw e;
    const current = await getFile(config, path).catch(() => null);
    return { configured: true, conflict: true, sha: current ? current.sha : msg.sha };
  }

  // A new note goes on the review schedule. If that write fails the note is
  // still saved, and it shows up as due until it's rated.
  if (!msg.sha) {
    const due = addDays(localDateKey(new Date()), FIRST_INTERVAL);
    await updateReviews(config, (reviews) => {
      if (reviews[msg.slug]) return null;
      reviews[msg.slug] = { due, interval: FIRST_INTERVAL };
      return `review: ${msg.title || msg.slug} due ${due}`;
    }).catch(() => {});
  }
  return { configured: true, sha, streak: await recordToday() };
}

async function rateReview(msg) {
  const config = await loadConfig();
  if (!config) return unconfigured();
  let next;
  await updateReviews(config, (reviews) => {
    next = reviews[msg.slug] = nextReview(reviews[msg.slug], msg.rating, localDateKey(new Date()));
    return `review: ${msg.title || msg.slug} (${msg.rating}), next ${next.due}`;
  });
  return { configured: true, ...next };
}

async function saveSolution(msg) {
  const config = await loadConfig();
  if (!config) return unconfigured();

  const path = solutionPath(config, msg.slug, msg.lang);
  const existing = await getFile(config, path);

  const message = `Solution code: ${msg.title || msg.slug}`;
  const sha = await saveFile(config, path, msg.code, existing?.sha, message);
  const streak = await recordToday();
  return { configured: true, path, sha, streak };
}

async function deleteNote(msg) {
  const config = await loadConfig();
  if (!config) return unconfigured();

  const path = notePath(config, msg.slug);
  const file = await getFile(config, path);
  if (!file) return { configured: true, deleted: false, reason: 'nothing committed yet' };

  // its reviews.json entry is left behind; due lists only show notes that exist
  await deleteFile(config, path, file.sha, `remove notes: ${msg.title || msg.slug}`);
  return { configured: true, deleted: true, path };
}

function slugTitle(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function dueReviews() {
  const config = await loadConfig();
  if (!config) return { due: [] };
  const [slugs, reviews] = await Promise.all([listNoteSlugs(config), getReviews(config)]);
  const today = localDateKey(new Date());

  // days = how overdue; null = never scheduled (counts as due)
  const due = slugs
    .filter((slug) => !reviews[slug] || reviews[slug].due <= today)
    .map((slug) => ({
      slug,
      title: slugTitle(slug),
      days: reviews[slug] ? daysBetween(reviews[slug].due, today) : null,
    }))
    .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity));

  return { due };
}

async function listNotes() {
  const config = await loadConfig();
  if (!config) return unconfigured();

  const [slugs, reviews] = await Promise.all([listNoteSlugs(config), getReviews(config).catch(() => ({}))]);

  // soonest review first; never-scheduled notes sort to the top
  const notes = slugs
    .map((slug) => ({ slug, title: slugTitle(slug), due: reviews[slug]?.due ?? null }))
    .sort((a, b) => (a.due || '').localeCompare(b.due || '') || a.title.localeCompare(b.title));

  return {
    configured: true,
    notes,
    repo: `${config.owner}/${config.repo}`,
    branch: config.branch,
    notesDir: config.notesDir,
  };
}

async function authStatus() {
  const { ghToken, ghLogin, ghAvatar, ghAuthKind, ghOwner, ghRepo, ghBranch, notesDir, solutionsDir } =
    await chrome.storage.local.get(['ghToken', 'ghLogin', 'ghAvatar', 'ghAuthKind', ...CONFIG_KEYS]);

  return {
    signedIn: !!ghToken,
    login: ghLogin || null,
    avatar: ghAvatar || null,
    authKind: ghAuthKind || (ghToken ? 'token' : null),
    repo: ghOwner && ghRepo ? `${ghOwner}/${ghRepo}` : null,
    branch: ghBranch || 'main',
    notesDir: notesDir || 'notes',
    solutionsDir: solutionsDir || 'solutions',
  };
}

async function authStart() {
  const d = await requestDeviceCode();
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    interval: d.interval || 5,
    expiresIn: d.expires_in || 900,
  };
}

async function authPoll(deviceCode) {
  const res = await pollForToken(deviceCode);
  if (res.status !== 'token') return res;

  const user = await getUser({ token: res.token });
  await chrome.storage.local.set({
    ghToken: res.token,
    ghLogin: user.login,
    ghAvatar: user.avatar_url,
    ghAuthKind: 'oauth',
  });
  return { status: 'token', login: user.login, avatar: user.avatar_url };
}

async function createRepoForUi(name) {
  const config = await loadToken();
  if (!config) return { signedIn: false };
  const repo = await createRepo(config, name);
  await chrome.storage.local.set({
    ghOwner: repo.owner, ghRepo: repo.name, ghBranch: repo.default_branch,
  });
  return { signedIn: true, repo };
}

async function setRepo(msg) {
  await chrome.storage.local.set({
    ghOwner: msg.owner,
    ghRepo: msg.repo,
    ghBranch: msg.branch || 'main',
    notesDir: msg.notesDir || 'notes',
    solutionsDir: msg.solutionsDir || 'solutions',
  });

  await refreshStreakFromRepo();
  return { ok: true };
}

async function readDays() {
  const { streakDays } = await chrome.storage.local.get('streakDays');
  return Array.isArray(streakDays) ? streakDays : [];
}

async function writeDays(days) {
  const unique = [...new Set(days)].sort().slice(-400);
  await chrome.storage.local.set({ streakDays: unique });
  return computeStreak(unique);
}

async function recordToday() {
  const days = await readDays();
  return writeDays([...days, localDateKey(new Date())]);
}

async function refreshStreakFromRepo() {
  const config = await loadConfig();
  if (!config) return computeStreak(await readDays());
  try {
    const dates = await noteCommitDates(config);
    const merged = [...(await readDays()), ...dates];
    await chrome.storage.local.set({ streakSyncedOn: localDateKey(new Date()) });
    return await writeDays(merged);
  } catch {
    return computeStreak(await readDays());
  }
}

async function getStreak() {
  const { streakSyncedOn } = await chrome.storage.local.get('streakSyncedOn');
  return streakSyncedOn !== localDateKey(new Date())
    ? refreshStreakFromRepo()
    : computeStreak(await readDays());
}
