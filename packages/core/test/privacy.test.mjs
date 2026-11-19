import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.ts';
import * as apiPrivacy from '../../../apps/api/src/privacy.ts';

const credentialValue = 'syntheticfixturevalue12345';
const escapedOnce = String.raw`password=\"${credentialValue}\"`;
const escapedTwice = String.raw`password=\\\"${credentialValue}\\\"`;

function privacy() {
  assert.equal(typeof core.containsPrivateContent, 'function', 'core must export the shared privacy screen');
  assert.equal(typeof core.containsCredentialLike, 'function', 'core must retain the compatibility alias');
  assert.ok(core.secretLike instanceof RegExp, 'core must export the shared credential pattern');
  return core.containsPrivateContent;
}

function nestedArray(depth) {
  let value = 'Safe synthetic context';
  for (let layer = 0; layer < depth; layer++) value = [value];
  return value;
}

test('core exports the same privacy screen and aliases used by existing API callers', () => {
  const containsPrivateContent = privacy();
  assert.equal(core.containsCredentialLike, containsPrivateContent);
  assert.equal(apiPrivacy.containsPrivateContent, containsPrivateContent);
  assert.equal(apiPrivacy.containsCredentialLike, containsPrivateContent);
  assert.equal(apiPrivacy.secretLike, core.secretLike);
});

test('shared privacy screen refuses raw quoted and nested synthetic credential markers', () => {
  const containsPrivateContent = privacy();
  const cases = [
    ['token prefix', 'sk-'+'syntheticfixture01234567890'],
    ['raw assignment', `password=${credentialValue}`],
    ['quoted assignment', `password="${credentialValue}"`],
    ['quoted JSON assignment', JSON.stringify({access_token:credentialValue})],
    ['credential field', {nested:[{api_key:credentialValue}]}],
    ['private key marker', '-----BEGIN '+'PRIVATE KEY-----'],
  ];
  for (const [name, value] of cases) {
    assert.equal(containsPrivateContent(value), true, name);
    assert.equal(apiPrivacy.containsPrivateContent(value), true, `API compatibility: ${name}`);
  }
});

test('shared privacy scan decodes one and two escaped assignment layers without a weaker raw match', () => {
  const containsPrivateContent = privacy();
  for (const [name, value] of [['once', escapedOnce], ['twice', escapedTwice]]) {
    assert.ok(value.includes('\\"'), `${name} fixture must preserve literal escaping`);
    assert.equal(core.secretLike.test(value), false, `${name} fixture must require the escaped-string scan`);
    assert.equal(containsPrivateContent({nested:[{comment:value}]}), true, name);
    assert.equal(apiPrivacy.containsPrivateContent({nested:[{comment:value}]}), true, `API compatibility: ${name}`);
  }
});

test('shared privacy screen permits clean Unicode text and bounded plain JSON', () => {
  const containsPrivateContent = privacy();
  const clean = {
    comment:'راجع هذه الخطوة — café 日本語 🙂',
    reference:{projectId:'sample-project',itemId:null,workflowId:'sample-flow',stepId:'review',specRevision:2,mapRevision:1},
    flags:[true,false,0],
  };
  assert.equal(containsPrivateContent(clean), false);
  assert.equal(apiPrivacy.containsPrivateContent(clean), false);
  assert.equal(containsPrivateContent(Object.assign(Object.create(null), {comment:'تعليق آمن'})), false);
});

test('exact configured-secret detection remains an explicit server-side parameter', () => {
  const containsPrivateContent = privacy();
  const knownSecret = 'synthetic-dedicated-credential';
  const value = {nested:[{comment:`Synthetic context ${knownSecret}`} ]};
  assert.equal(core.secretLike.test(knownSecret), false, 'fixture must depend on the known-secret parameter');
  assert.equal(containsPrivateContent(value), false);
  assert.equal(containsPrivateContent(value, knownSecret), true);
  assert.equal(apiPrivacy.containsPrivateContent(value, knownSecret), true);
  assert.equal(apiPrivacy.containsCredentialLike(value, knownSecret), true);
  assert.equal(containsPrivateContent(value, 'different-synthetic-credential'), false);
});

test('shared privacy screen preserves its depth and visited-value limits with positive boundary controls', () => {
  const containsPrivateContent = privacy();
  assert.equal(containsPrivateContent(nestedArray(32)), false);
  assert.equal(containsPrivateContent(nestedArray(33)), true);
  assert.equal(containsPrivateContent(Array(9999).fill(null)), false);
  assert.equal(containsPrivateContent(Array(10000).fill(null)), true);
});

test('shared privacy screen fails closed on cycles repeated objects and non-JSON values', () => {
  const containsPrivateContent = privacy();
  const cyclic = {};
  cyclic.self = cyclic;
  const shared = {comment:'Safe synthetic context'};
  for (const value of [cyclic,[shared,shared],new Date(0),new Map(),undefined,1n,Symbol('synthetic'),() => {}]) {
    assert.equal(containsPrivateContent(value), true);
    assert.equal(apiPrivacy.containsPrivateContent(value), true);
  }
  assert.equal(containsPrivateContent([{comment:'Safe synthetic context'},{comment:'Safe synthetic context'}]), false);
});
