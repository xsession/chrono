import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require("typescript");

const source = fs.readFileSync(new URL('../src/conflictMarkers.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
vm.runInNewContext(`(function(module,exports,require){${compiled}\n})(module,module.exports,require);`, { module, require, console });
const { parseConflictBlocks, replaceConflictBlock } = module.exports;

function assert(condition, message) { if (!condition) throw new Error(message); }

const simple = `prefix\n<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> topic\nsuffix\n`;
assert(parseConflictBlocks(simple).length === 1, 'simple block count');
assert(replaceConflictBlock(simple, 0, 'current') === 'prefix\ncurrent\nsuffix\n', 'current replacement');
assert(replaceConflictBlock(simple, 0, 'incoming') === 'prefix\nincoming\nsuffix\n', 'incoming replacement');
assert(replaceConflictBlock(simple, 0, 'bothCurrent') === 'prefix\ncurrent\nincoming\nsuffix\n', 'both current-first');

const diff3 = `<<<<<<< HEAD\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> topic\n`;
assert(parseConflictBlocks(diff3).length === 1, 'diff3 block count');
assert(replaceConflictBlock(diff3, 0, 'incoming') === 'theirs\n', 'diff3 incoming replacement');

const two = `<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\nmiddle\n<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> y\n`;
assert(parseConflictBlocks(two).length === 2, 'two block count');
const firstResolved = replaceConflictBlock(two, 0, 'current');
assert(parseConflictBlocks(firstResolved).length === 1, 'one block remains');
assert(replaceConflictBlock(firstResolved, 0, 'incoming') === 'a\nmiddle\nd\n', 'second block advances after first replacement');

console.log('PASS conflict marker parser and block replacement');
