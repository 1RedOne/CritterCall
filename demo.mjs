import { character } from './session-source.mjs';

export function demoSessions() {
  const titles = [
    'Polishing the dashboard', 'Untangling a race condition', 'Making tests a little happier',
    'Exploring the codebase', 'Writing the release notes', 'Checking the API contract',
    'Tracking down a flaky test', 'Sketching the next feature', 'Refactoring the helpers',
    'Reviewing the latest changes', 'Measuring startup time', 'Tidying up the docs',
  ];
  return titles.map((title, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    return { id, title, ...character(id), repository: 'demo/critter-workshop',
      status: index % 3 ? 'working' : 'quiet', messages: [], demo: true };
  });
}

export function seedDemo(store) {
  const sessions = demoSessions();
  [
    ['question', 'Should the new dashboard open in grid view or focus view? I have both sketches ready.'],
    ['context', 'I found two versions of the API contract. Which one should I use as the source of truth?'],
    ['update', 'The flaky test is fixed! It was sharing a timer between runs. All ready for a look.'],
  ].forEach(([kind, message], index) => store.raise({ sessionId: sessions[index].id, kind, message }));
}
