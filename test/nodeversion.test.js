// Echo needs Node 22.18+ (it runs TypeScript directly). Every place that picks or checks Node agrees,
// and an update that needs a newer Node is refused with a clear message instead of failing to start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.js';

sandbox('nodeversion');
const { MIN_NODE, nodeSatisfies, parseNode, rangeFloor } = await import('../lib/nodeversion.js');
const root = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('versions compare part by part', () => {
  assert.deepEqual(parseNode('v22.18.0'), [22, 18, 0]);
  assert.deepEqual(parseNode('24'), [24, 0, 0]);
  assert.equal(parseNode('nope'), null);
  assert.equal(nodeSatisfies('22.18.0', '>=22.18'), true);
  assert.equal(nodeSatisfies('22.20.0', '>=22.18'), true);
  assert.equal(nodeSatisfies('24.1.0', '>=22.18'), true);
  assert.equal(nodeSatisfies('22.17.9', '>=22.18'), false);
  assert.equal(nodeSatisfies('20.19.0', '>=22.18'), false);
  assert.equal(nodeSatisfies('22.9.0', '>=22.18'), false, '9 is less than 18, not more');
  assert.equal(nodeSatisfies('20.0.0', undefined), true, 'no requirement');
  assert.equal(nodeSatisfies('20.0.0', '>=banana'), true, 'an unreadable requirement never locks updates out');
  assert.equal(rangeFloor('>=22.18.0'), '22.18');
});

test('this Node, package.json, the launcher and the installers agree on the floor', () => {
  assert.equal(nodeSatisfies(process.versions.node, `>=${MIN_NODE}`), true, 'the tests themselves run on a supported Node');
  assert.equal(JSON.parse(read('package.json')).engines.node, '>=22.18');
  assert.equal(rangeFloor(`>=${MIN_NODE}`), '22.18');
  for (const f of ['scripts/launcher.sh', 'scripts/install.sh']) {
    assert.match(read(f), /-ge 22018/, `${f} checks 22.18`);
    assert.doesNotMatch(read(f), /Node\.js 20 or newer/, `${f} no longer says 20`);
  }
  assert.match(read('scripts/install-node.sh'), /MIN_NODE=22018/);
});

test("the launcher's check accepts 22.18 and up and turns down older Node", () => {
  const src = read('scripts/launcher.sh');
  const fn = src.slice(src.indexOf('node_ok() {'), src.indexOf('}\n', src.indexOf('node_ok() {')) + 2);
  const dir = fs.mkdtempSync(path.join(path.dirname(process.execPath) === '/' ? '/tmp' : process.env.ECHO_DATA_DIR || '/tmp', 'fake-node-'));
  const fake = (version) => {
    const f = path.join(dir, `node-${version}`);
    fs.writeFileSync(f, `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'Object.defineProperty(process.versions, "node", { value: "${version}" }); const s = process.argv.at(-1); console.log(eval(s))' "$2"\n`, { mode: 0o755 });
    return f;
  };
  const ok = (version) => {
    try {
      execFileSync('/bin/bash', ['-c', `${fn}\nnode_ok ${fake(version)}`]);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ok('22.18.0'), true);
  assert.equal(ok('24.2.1'), true);
  assert.equal(ok('22.17.1'), false);
  assert.equal(ok('20.19.4'), false);
});

test('the package ships tsconfig.json', () => {
  assert.match(read('scripts/package.js'), /'tsconfig\.json'/);
});
