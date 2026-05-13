import {
  insertQuoteAsSecondSection as libInsertQuoteAsSecondSection,
  swapSections2And3 as libSwapSections2And3,
  cloneThirdSectionAfterwards as libCloneThirdSectionAfterwards,
  getPublishStore as libGetPublishStore,
  getSections as libGetSections,
  setSections,
  cloneValue,
} from './section-tools-lib';

const MAX_UNDO_STEPS = 10;
const mutationHistory = [];

export function pushUndoSnapshot() {
  const sections = libGetSections(window.Statamic);

  if (!sections) {
    return false;
  }

  mutationHistory.push(cloneValue(sections));

  if (mutationHistory.length > MAX_UNDO_STEPS) {
    mutationHistory.shift();
  }

  return true;
}

export function popUndoSnapshot() {
  return mutationHistory.pop() ?? null;
}

export function insertQuoteAsSecondSection() {
  if (!pushUndoSnapshot()) {
    window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
    return;
  }

  if (libInsertQuoteAsSecondSection(window.Statamic)) {
    window.Statamic.$toast.success('Zitat als zweiter Abschnitt eingefuegt.');
  } else {
    popUndoSnapshot();
    window.Statamic.$toast.error('Aktualisierung fehlgeschlagen.');
  }
}

export function swapSections2And3() {
  const sections = libGetSections(window.Statamic);

  if (!sections) {
    window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
    return;
  }

  if (sections.length < 3) {
    window.Statamic.$toast.warning('Mindestens 3 Abschnitte benoetigt.');
    return;
  }

  if (!pushUndoSnapshot()) {
    window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
    return;
  }

  if (libSwapSections2And3(window.Statamic)) {
    window.Statamic.$toast.success('Abschnitte 2 und 3 wurden getauscht.');
  } else {
    popUndoSnapshot();
    window.Statamic.$toast.error('Aktualisierung fehlgeschlagen.');
  }
}

export function cloneThirdSectionAfterwards() {
  const sections = libGetSections(window.Statamic);

  if (!sections) {
    window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
    return;
  }

  if (sections.length < 3) {
    window.Statamic.$toast.warning('Mindestens 3 Abschnitte benoetigt.');
    return;
  }

  if (!pushUndoSnapshot()) {
    window.Statamic.$toast.error('Publish state wurde nicht gefunden.');
    return;
  }

  if (libCloneThirdSectionAfterwards(window.Statamic)) {
    window.Statamic.$toast.success('Abschnitt 3 wurde geklont und eingefuegt.');
  } else {
    popUndoSnapshot();
    window.Statamic.$toast.error('Aktualisierung fehlgeschlagen.');
  }
}

export function undoLastMutation() {
  if (mutationHistory.length === 0) {
    return;
  }

  const previousSections = popUndoSnapshot();
  if (!previousSections) {
    return;
  }

  if (setSections(window.Statamic, previousSections)) {
    window.Statamic.$toast.success('Letzte Mutation wurde rueckgaengig gemacht.');
    return;
  }

  mutationHistory.push(previousSections);
  window.Statamic.$toast.error('Undo fehlgeschlagen.');
}
