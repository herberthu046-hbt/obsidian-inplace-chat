'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DefaultMention } = require('../src/default-mention.cjs');
function field(value = '', allowed = true) {
  const f = { value, matches: () => allowed, events: [], ownerDocument: { defaultView: { Event: class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } } } },
    dispatchEvent(event) { this.events.push(event); this.nativeDraft = this.value; },
    setSelectionRange(a, b) { this.selection = [a, b]; } };
  return f;
}
test('focused empty native comment receives @chat through its native input handler', () => {
  const feature = new DefaultMention(), input = field();
  assert.equal(feature.seed(input), true);
  assert.equal(input.nativeDraft, '@chat ');
  assert.deepEqual(input.selection, [6, 6]);
  assert.equal(input.events[0].type, 'input');
  input.value = '';
  assert.equal(feature.seed(input), false);
  assert.equal(input.value, '');
});
test('existing drafts, deleted edits, other fields and disabled setting are preserved', () => {
  const feature = new DefaultMention(), existing = field('existing comment');
  assert.equal(feature.seed(existing), false);
  existing.value = '';
  assert.equal(feature.seed(existing), false);
  for (const input of [field('', false), { ...field(), disabled: true }, { ...field(), readOnly: true }]) assert.equal(feature.seed(input), false);
  assert.equal(new DefaultMention(() => false).seed(field()), false);
});
test('mounting observers never seeds unfocused historical PDF notes', () => {
  const input = field(), callbacks = {}, doc = { body: {}, activeElement: field('', false) };
  let mutation;
  const win = { document: doc, addEventListener: (name, cb) => { callbacks[name] = cb; }, removeEventListener: name => delete callbacks[name],
    MutationObserver: class { constructor(cb) { mutation = cb; } observe() {} disconnect() {} } };
  const detach = new DefaultMention().attach(win);
  mutation(); assert.equal(input.value, '');
  callbacks.focusin({ target: input }); assert.equal(input.value, '@chat ');
  detach(); assert.equal(callbacks.focusin, undefined);
});
test('remounting a PDF note preserves deletion without affecting a different annotation', () => {
  const feature = new DefaultMention(), first = field(), card = { dataset: { annotationId: 'a' } };
  first.closest = selector => selector.startsWith('[data-annotation-id]') ? card : null;
  assert.equal(feature.seed(first), true);
  const remounted = field(); remounted.ownerDocument = first.ownerDocument; remounted.closest = first.closest;
  assert.equal(feature.seed(remounted), false);
  assert.equal(remounted.value, '');
  const other = field(); other.ownerDocument = first.ownerDocument;
  other.closest = selector => selector.startsWith('[data-annotation-id]') ? { dataset: { annotationId: 'b' } } : null;
  assert.equal(feature.seed(other), true);
});
test('a recreated Markdown composer preserves deletion and a new reply gets its own default', () => {
  const feature = new DefaultMention(); let count = 1;
  const card = { querySelectorAll: () => Array(count) };
  const input = () => { const f = field(); f.closest = selector => selector === '.doc-comment-card' || selector === '.dc-field--composer' ? card : null; return f; };
  assert.equal(feature.seed(input()), true);
  assert.equal(feature.seed(input()), false);
  count++;
  assert.equal(feature.seed(input()), true);
});
