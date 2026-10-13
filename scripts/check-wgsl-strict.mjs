#!/usr/bin/env node
// Stdlib-only grammar check for the generated WGSL (run after npm run build).
// WGSL §8.19–8.20: https://www.w3.org/TR/WGSL/#operator-precedence-associativity
// This is a syntax/precedence checker, not a replacement for compiler type,
// uniformity, resource-layout or device-limit validation. Unknown syntax fails
// closed, so a new generator construct cannot silently escape expression checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { shaderMatrix } from './wgsl-strict-matrix.mjs';

// Parse permissively with naga's actual precedence, then check every AST edge
// against WGSL's expression grammar. Naga v29.0.1 parse/mod.rs:
// expression / equality_expression / parse_binary_op.
// Lowest to highest; every level is left associative. Parentheses, call args,
// indices and template arguments each start a new expression.
const precedence = Object.fromEntries([
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='],
  ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
].flatMap((ops, i) => ops.map(op => [op, i + 1])));
const bitwise = new Set(['&', '|', '^']);
const shift = new Set(['<<', '>>']);
const relation = new Set(['==', '!=', '<', '<=', '>', '>=']);
const arithmetic = new Set(['+', '-', '*', '/', '%']);
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const templates = /^(array|binding_array|atomic|ptr|vec[234]|mat[234]x[234]|texture_\w+)$/;

function allowed(parent, child) {
  if (bitwise.has(parent)) return parent === child;
  if (shift.has(parent)) return false; // even a << b << c and a + b << c are invalid
  if (relation.has(parent)) return arithmetic.has(child) || shift.has(child);
  if (parent === '&&' || parent === '||') return parent === child || relation.has(child) || arithmetic.has(child) || shift.has(child);
  return arithmetic.has(child);
}

function tokenize(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) {
      const start = i; i += 2; let depth = 1;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error(`unterminated comment at byte ${start}`);
      continue;
    }
    const rest = source.slice(i);
    const value = rest.match(/^(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?[iufh]?|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[iufh]?|[\p{L}_][\p{L}\p{N}_]*|<<=|>>=|&&|\|\||==|!=|<=|>=|<<|>>|\+\+|--|->|[+\-*/%&|^]=|[{}()[\],;:.@=+\-*/%&|^!~<>])/u)?.[0];
    if (!value) throw new Error(`unrecognized token at byte ${i}: ${rest.slice(0, 20)}`);
    out.push({ value, start: i, end: i + value.length }); i += value.length;
  }
  out.push({ value: '<eof>', start: i, end: i });
  return out;
}

export function checkWGSL(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const issues = [];
  const typeNames = new Set();
  const peek = () => tokens[pos].value;
  const take = () => tokens[pos++];
  const accept = value => peek() === value ? take() : null;
  const expect = value => {
    if (!accept(value)) throw new Error(`expected ${value}, found ${peek()} at byte ${tokens[pos].start}`);
  };
  const identifier = () => {
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(peek())) throw new Error(`expected identifier at byte ${tokens[pos].start}`);
    const token = take();
    if (token.value.startsWith('__')) issues.push({ ...token, message: 'identifiers starting with __ are reserved' });
    return token;
  };
  const closeTemplate = () => {
    // WGSL context-dependent tokenization: nested array<vec4<u32>> ends two
    // template lists; it is not a shift expression.
    if (peek() === '>>') {
      const t = tokens[pos];
      tokens.splice(pos, 1, { value: '>', start: t.start, end: t.start + 1 }, { value: '>', start: t.start + 1, end: t.end });
    }
    expect('>');
  };
  function type() {
    identifier();
    if (accept('<')) {
      do {
        if (/^[\p{L}_]/u.test(peek()) && precedence[tokens[pos + 1].value] === undefined) type();
        else expression(0, true);
      } while (accept(','));
      closeTemplate();
    }
  }
  function args(end) {
    if (accept(end)) return;
    do { expression(); } while (accept(',') && peek() !== end);
    expect(end);
  }
  function expression(min = 0, inTemplate = false) {
    let left;
    if (['!', '~', '-', '*', '&'].includes(peek())) {
      const t = take(); const child = expression(11, inTemplate);
      left = { start: t.start, end: child.end };
    } else if (accept('(')) {
      const start = tokens[pos - 1].start;
      expression(); expect(')'); left = { start, end: tokens[pos - 1].end };
    } else {
      const t = take();
      if (!/^(?:[\p{L}_]|\d|\.\d)/u.test(t.value)) throw new Error(`expected expression, found ${t.value} at byte ${t.start}`);
      if (t.value.startsWith('__')) issues.push({ ...t, message: 'identifiers starting with __ are reserved' });
      if ((templates.test(t.value) || typeNames.has(t.value)) && peek() === '<') {
        pos--; type();
      }
      left = { start: t.start, end: tokens[pos - 1].end };
    }
    while (true) {
      if (accept('(')) { args(')'); left = { start: left.start, end: tokens[pos - 1].end }; }
      else if (accept('[')) { expression(); expect(']'); left = { start: left.start, end: tokens[pos - 1].end }; }
      else if (accept('.')) { identifier(); left = { start: left.start, end: tokens[pos - 1].end }; }
      else break;
    }
    while (precedence[peek()] > min && !(inTemplate && ['>', '>>'].includes(peek()))) {
      const t = take(); const right = expression(precedence[t.value], inTemplate);
      for (const child of [left, right]) {
        if (child.op && !allowed(t.value, child.op)) issues.push({
          ...t, message: `mixing ${t.value} with ${child.op} requires parentheses`,
          expression: source.slice(Math.min(left.start, right.start), right.end),
          child: source.slice(child.start, child.end),
        });
      }
      left = { op: t.value, start: left.start, end: right.end };
    }
    return left;
  }
  function attrs() {
    while (accept('@')) { identifier(); if (accept('(')) args(')'); }
  }
  function declaration() {
    const kind = take().value;
    if (kind === 'var' && accept('<')) { identifier(); if (accept(',')) identifier(); closeTemplate(); }
    identifier(); if (accept(':')) type(); if (accept('=')) expression();
  }
  function simple() {
    if (['var', 'let', 'const'].includes(peek())) declaration();
    else {
      expression();
      if (assignments.has(peek())) { take(); expression(); }
      else if (peek() === '++' || peek() === '--') take();
    }
  }
  function block() { expect('{'); while (peek() !== '}') statement(); expect('}'); }
  function statement() {
    attrs();
    switch (peek()) {
      case '{': block(); break;
      case ';': take(); break;
      case 'if':
        take(); expression(); block();
        if (accept('else')) { if (peek() === 'if') statement(); else block(); }
        break;
      case 'while': take(); expression(); block(); break;
      case 'for':
        take(); expect('('); if (peek() !== ';') simple(); expect(';');
        if (peek() !== ';') expression(); expect(';'); if (peek() !== ')') simple(); expect(')'); block(); break;
      case 'loop': case 'continuing': take(); block(); break;
      case 'switch':
        take(); expression(); attrs(); expect('{');
        while (peek() !== '}') {
          if (accept('case')) {
            do { if (!accept('default')) expression(); } while (accept(','));
          } else expect('default');
          accept(':'); block();
        }
        expect('}'); break;
      case 'return': take(); if (peek() !== ';') expression(); expect(';'); break;
      case 'break': take(); if (accept('if')) expression(); expect(';'); break;
      case 'continue': case 'discard': take(); expect(';'); break;
      case 'const_assert': take(); expression(); expect(';'); break;
      default: simple(); expect(';');
    }
  }
  while (peek() !== '<eof>') {
    attrs();
    switch (peek()) {
      case ';': take(); break;
      case 'fn':
        take(); identifier(); expect('(');
        if (peek() !== ')') do { attrs(); identifier(); expect(':'); type(); } while (accept(',') && peek() !== ')');
        expect(')'); if (accept('->')) { attrs(); type(); } block(); break;
      case 'struct': {
        take(); typeNames.add(identifier().value); expect('{');
        while (peek() !== '}') { attrs(); identifier(); expect(':'); type(); if (peek() !== '}') expect(','); }
        expect('}'); accept(';'); break;
      }
      case 'alias': take(); typeNames.add(identifier().value); expect('='); type(); expect(';'); break;
      case 'const': case 'override': case 'var': declaration(); expect(';'); break;
      case 'const_assert': take(); expression(); expect(';'); break;
      case 'enable': case 'requires': take(); do { identifier(); } while (accept(',')); expect(';'); break;
      case 'diagnostic': take(); expect('('); args(')'); expect(';'); break;
      default: throw new Error(`unrecognized module syntax ${peek()} at byte ${tokens[pos].start}`);
    }
  }
  return issues.map(issue => {
    const before = source.slice(0, issue.start);
    return { ...issue, line: before.split('\n').length, column: issue.start - before.lastIndexOf('\n') };
  });
}

export function selfTest() {
  const invalid = [
    'a || b && c', 'a && b || c', 'a | b & c', 'a & b ^ c', 'a ^ b | c',
    'a & b == c', 'a < b | c', 'a | b && c', 'a & b + c', 'a * b ^ c',
    'a << b | c', 'a & b >> c', 'a << b << c', 'a << b >> c', 'a + b << c', 'a << b + c',
    'a < b < c', 'a == b == c', 'a < b == c', 'a != b >= c',
    'f(a | b & c)', 'a[b || c && d]', 'array<u32, (a | b & c)>()',
  ];
  const valid = [
    'a || (b && c)', '(a || b) && c', 'a | (b & c)', '(a & b) ^ c',
    '(a & b) == c', 'a & (b == c)', 'a + b * c', 'a - b + c', 'a | b | c',
    'a & b & c', 'a ^ b ^ c', '(a + b) << c', 'a << (b + c)', '(a << b) >> c',
    'a << b < c >> d', 'a + b < c * d || e == f', '!a && b && c',
    'f(a & b, c | d)', 'a[(b & c)]', 'array<vec4<u32>, 4>()',
  ];
  for (const e of invalid) assert(checkWGSL(`fn f() { let x = ${e}; }`).length, e);
  for (const e of valid) assert.equal(checkWGSL(`fn f() { let x = ${e}; }`).length, 0, e);
  assert.equal(checkWGSL('// a | b & c\n/* outer /* a || b && c */ end */ fn f() {}').length, 0);
  assert.throws(() => checkWGSL('fn f() { let x = ?; }'));
  assert.throws(() => checkWGSL('fn f() { let x = a b; }'));
  assert.throws(() => checkWGSL('/* unfinished'));
}

async function main() {
  selfTest();
  const files = process.argv.slice(2);
  const shaders = files.length ? files.map(file => ({ label: file, wgsl: readFileSync(file, 'utf8') })) : await shaderMatrix();
  let failures = 0;
  for (const { label, wgsl } of shaders) {
    try {
      const issues = checkWGSL(wgsl);
      for (const issue of issues) console.error(`${label}:${issue.line}:${issue.column}: ${issue.message}\n  ${issue.expression ?? ''}`);
      failures += issues.length;
    } catch (error) { failures++; console.error(`${label}: ${error.message}`); }
  }
  console.log(`WGSL strict grammar: ${shaders.length} generated texts, ${failures} errors (checker self-tests passed)`);
  if (failures) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
