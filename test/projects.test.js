import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('projects');
const mk = (name, files = {}) => {
  fs.mkdirSync(path.join(dirs.projects, name), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dirs.projects, name, f), body);
};
mk('Foodbowl', { 'index.html': '<html><title>Foodbowl: a vegetarian recipe guide</title></html>' });
mk('Budget2', { 'package.json': JSON.stringify({ description: 'Family budget planner website', dependencies: { next: '1' } }) });
mk('FitTrack', { 'README.md': '# FitTrack\n\nA workout tracking web app with plans and progress charts.' });
mk('World Cup');
mk('Garden Project');
mk('untitled folder');
// A clean store: no seeded aliases, so we test pure sound/spelling matching.
fs.writeFileSync(path.join(dirs.data, 'projects.json'), JSON.stringify({ aliases: {}, hidden: ['untitled folder'], descriptions: {} }));

const P = await import('../lib/projects.js');

test('phonetic keys treat common mishearings as the same', () => {
  assert.equal(P.phoneticKey('football'), P.phoneticKey('foodbowl'));
  assert.equal(P.phoneticKey('fit track'), P.phoneticKey('FitTrack'));
});

test('exact and spaced names match confidently', () => {
  assert.equal(P.matchProject('fit track').project?.name, 'FitTrack');
  assert.equal(P.matchProject('budget').project?.name, 'Budget2');
  assert.equal(P.matchProject('the garden project').project?.name, 'Garden Project');
});

test('a misheard name is suggested, not acted on', () => {
  const m = P.matchProject('football');
  assert.equal(m.project, null, 'should ask before acting');
  assert.equal(m.candidates[0], 'Foodbowl');
});

test('confirmed aliases are remembered', () => {
  P.addAlias('football', 'Foodbowl');
  assert.equal(P.matchProject('football').project?.name, 'Foodbowl');
  P.addAlias('money', 'Budget2');
  assert.equal(P.matchProject('the money project').project?.name, 'Budget2');
  const saved = JSON.parse(fs.readFileSync(path.join(dirs.data, 'projects.json'), 'utf8'));
  assert.equal(saved.aliases.football, 'Foodbowl');
});

test('hidden folders and Echo workspaces are not listed', () => {
  fs.mkdirSync(dirs.research, { recursive: true });
  const names = P.listProjects().map((p) => p.name);
  assert.ok(!names.includes('untitled folder'));
  assert.ok(!names.includes('_research'));
  P.setHidden('World Cup', true);
  assert.ok(!P.listProjects().some((p) => p.name === 'World Cup'));
  P.setHidden('World Cup', false);
  assert.ok(P.listProjects().some((p) => p.name === 'World Cup'));
});

test('projects get short descriptions', () => {
  const byName = Object.fromEntries(P.listProjects().map((p) => [p.name, p]));
  assert.match(byName.Foodbowl.description, /vegetarian/);
  assert.match(byName.Budget2.description, /budget planner/);
  assert.match(byName.FitTrack.description, /workout tracking/);
  P.setDescription('World Cup', 'Soccer schedule tracker');
  assert.equal(P.listProjects().find((p) => p.name === 'World Cup').description, 'Soccer schedule tracker');
});
