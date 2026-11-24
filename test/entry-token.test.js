import test from 'node:test';
import assert from 'node:assert/strict';

import { entryTokenFrom } from '../lib/proxy.mjs';

const base = 'http://127.0.0.1:64353/';

test('入口 token：取同源同路径且只带一个 token 的那条（issue #230）', () => {
  const entries = [
    { label: 'ollama', url: 'http://127.0.0.1:64353/?token=abc' },
    { label: 'remote', url: 'http://127.0.0.1:64353/?token=deadbeef' },
  ];
  assert.equal(entryTokenFrom(entries, base), 'abc');
});

test('入口 token：忽略不同源、不同路径、多个 token 与空 token', () => {
  const entries = [
    { label: 'other-port', url: 'http://127.0.0.1:3080/?token=nope' },
    { label: 'other-path', url: 'http://127.0.0.1:64353/sub?token=nope' },
    { label: 'twice', url: 'http://127.0.0.1:64353/?token=a&token=b' },
    { label: 'blank', url: 'http://127.0.0.1:64353/?token=' },
    { label: 'good', url: 'http://127.0.0.1:64353/?token=ok' },
  ];
  assert.equal(entryTokenFrom(entries, base), 'ok');
});

test('入口 token：没有入口或入口畸形时返回空串', () => {
  assert.equal(entryTokenFrom(undefined, base), '');
  assert.equal(entryTokenFrom([], base), '');
  assert.equal(entryTokenFrom([{ url: 'not a url' }, {}], base), '');
  assert.equal(entryTokenFrom([{ url: 'http://127.0.0.1:64353/?token=x' }], 'not a url'), '');
});
