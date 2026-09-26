#!/usr/bin/env node
// Historical deadline observation. Correctness regressions live in visible-requeue and recovery.
// S10-02 healthy behavior lives in check-preview-visible-requeue.cjs.
const path = require('node:path');
process.chdir(path.resolve(__dirname, '../..'));
if (!process.argv.includes('--observe') && !process.argv.includes('--strict'))
    throw Error('Use --observe or --strict');
async function deadlineBaseline() {
    const fs = require('fs'), ts = require(process.cwd() + '/node_modules/typescript'), assert = require('assert/strict');
    function load(p, req) { let m = { exports: {} }; new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(p, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(req, m, m.exports); return m.exports; }
    const deadline = load('src/main/path/ioDeadlineRuntime.ts', () => ({ sharedFileSystem: {} }));
    return (async () => { let finish, done = false; const result = await deadline.withIoDeadlineResult('audit', () => new Promise(r => finish = () => { done = true; r('late'); }), 100); assert(result.timedOut); assert(!done); finish(); await Promise.resolve(); assert(done); console.log('PASS actual deadline helper: timeout returns while operation remains alive and completes later'); })();
}
(async () => {
    await deadlineBaseline();

    console.log("S10-01 five baseline defects now covered by healthy S10-02/03 regressions; deadline physical cancellation remains S10-05. Not GUI evidence.");
})().catch(error => { console.error(error); process.exitCode = 1; });
