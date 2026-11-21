// node github.test.mjs — checks the review scheduling and streak math.
import assert from 'node:assert/strict';
import {
  addDays, daysBetween, nextReview, computeStreak, localDateKey, FIRST_INTERVAL,
  splitFrontmatter, joinFrontmatter,
} from './github.js';

assert.equal(addDays('2026-11-21', 3), '2026-11-24');
assert.equal(addDays('2026-12-30', 3), '2027-01-02');
assert.equal(addDays('2026-03-01', -1), '2026-02-28');
assert.equal(daysBetween('2026-11-20', '2026-11-21'), 1);
assert.equal(daysBetween('2026-02-25', '2026-03-05'), 8);
assert.equal(daysBetween('2026-11-21', '2026-11-21'), 0);

const today = '2026-11-21';
assert.deepEqual(nextReview(null, 'easy', today), { due: '2026-11-29', interval: 8 });
assert.deepEqual(nextReview({ interval: 8 }, 'easy', today), { due: '2026-12-11', interval: 20 });
assert.deepEqual(nextReview({ interval: 8 }, 'hard', today), { due: '2026-12-03', interval: 12 });
assert.deepEqual(nextReview({ interval: 20 }, 'again', today), { due: '2026-11-22', interval: 1 });
assert.deepEqual(nextReview({ interval: 1 }, 'hard', today), { due: '2026-11-23', interval: 2 });
assert.deepEqual(nextReview({ interval: 1 }, 'easy', today), { due: '2026-11-25', interval: 4 });
assert.equal(FIRST_INTERVAL, 3);

const day = (n) => localDateKey(new Date(Date.now() - n * 86400000));
const s = computeStreak([day(0), day(1), day(2), day(5)]);
assert.deepEqual([s.current, s.best, s.total, s.doneToday], [3, 3, 4, true]);
assert.equal(computeStreak([day(1)]).doneToday, false);

const note = joinFrontmatter([], {
  number: '1', title: 'Two Sum', difficulty: 'Easy', tags: ['Array', 'Hash Table'],
  url: 'https://leetcode.com/problems/two-sum/', created: '2026-11-21', updated: '2026-11-21',
}, 'body\n');
assert.equal(note, '---\nnumber: 1\ntitle: "Two Sum"\ndifficulty: "Easy"\ntags: ["Array", "Hash Table"]\n'
  + 'url: "https://leetcode.com/problems/two-sum/"\ncreated: 2026-11-21\nupdated: 2026-11-21\n---\n\nbody\n');
assert.equal(splitFrontmatter(note).body, 'body\n');
assert.deepEqual(splitFrontmatter('---\nno frontmatter'), { entries: [], body: '---\nno frontmatter' });
assert.equal(splitFrontmatter('---\r\ntitle: x\r\n---\r\n\r\nbody').body, 'body');
assert.equal(joinFrontmatter([], { title: 'Pow(x, n): "fast"' }, ''), '---\ntitle: "Pow(x, n): \\"fast\\""\n---\n\n');

// unknown keys and block lists survive; a managed key is replaced whole; a missing value keeps the old one
const { entries, body } = splitFrontmatter('---\naliases:\n  - ts\ntags:\n  - old\n  - older\ndifficulty: Hard\n---\nbody');
assert.equal(joinFrontmatter(entries, { tags: ['Array'], difficulty: null }, body),
  '---\naliases:\n  - ts\ntags: ["Array"]\ndifficulty: Hard\n---\n\nbody');

console.log('github.test.mjs: ok');
