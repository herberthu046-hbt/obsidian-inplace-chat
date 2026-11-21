'use strict';
// Add a draft default through native input events; never patch either plugin.
const SELECTOR = '.dc-field--composer textarea.dc-field__input, .dc-field--edit textarea.dc-field__input, textarea.dc-modal-input, textarea.lpa-margin-note, textarea.lpa-native-note:not(.lpa-native-side-note), textarea.ipc-pdf-input';
class DefaultMention {
  constructor(enabled = () => true) { this.enabled = enabled; this.seen = new WeakSet(); this.drafts = new WeakMap(); }
  draftIdentity(field) {
    const reader = field.closest?.('.ipc-reader-thread');
    if (reader?.dataset?.threadId) return [field.ownerDocument, `reader:${reader.dataset.threadId}:${reader.querySelectorAll('.ipc-reader-entry').length}`];
    const annotation = field.closest?.('[data-annotation-id], [data-hl-id]');
    const id = annotation?.dataset?.annotationId || annotation?.dataset?.hlId;
    if (id) return [field.ownerDocument, `pdf:${id}`];
    const card = field.closest?.('.doc-comment-card');
    if (card) return [card, `${field.closest('.dc-field--composer') ? 'reply' : 'edit'}:${card.querySelectorAll('.dc-entry').length}`];
    return [field.closest?.('.lpa-mark-popover, .modal-container') || field, 'input'];
  }
  seed(field) {
    if (!this.enabled() || !field?.matches?.(SELECTOR) || field.disabled || field.readOnly || this.seen.has(field)) return false;
    this.seen.add(field); // Includes existing drafts: deleting text must not reinsert @chat.
    // Preserve that decision when a native card replaces its textarea.
    const [scope, key] = this.draftIdentity(field);
    let drafts = this.drafts.get(scope);
    if (!drafts) { drafts = new Set(); this.drafts.set(scope, drafts); }
    if (drafts.has(key)) return false;
    drafts.add(key);
    if (field.value !== '') return false;
    field.value = '@chat ';
    field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true }));
    field.setSelectionRange?.(field.value.length, field.value.length);
    return true;
  }
  attach(win) {
    const focus = event => this.seed(event.target);
    win.addEventListener('focusin', focus, true);
    // Some native editors focus before insertion into the document. Check only
    // the active field, so opening a PDF never edits all its empty notes.
    const observer = win.MutationObserver ? new win.MutationObserver(() => this.seed(win.document.activeElement)) : null;
    if (win.document?.body) observer?.observe(win.document.body, { subtree: true, childList: true });
    this.seed(win.document?.activeElement);
    return () => { win.removeEventListener('focusin', focus, true); observer?.disconnect(); };
  }
}
module.exports = { DefaultMention, SELECTOR };
