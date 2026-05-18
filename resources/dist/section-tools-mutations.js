import {
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
