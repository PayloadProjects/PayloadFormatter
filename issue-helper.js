// Issue bar: when a payload is still broken after formatting, says what is
// wrong in plain words, where (line and column, underlined in the editor),
// and offers the fix when it is unambiguous. The diagnosis itself is pure
// logic in payload-diagnose.js; this module only shows it and applies the
// fix through the editor as an ordinary edit.
import { diagnose, guessMode } from './payload-diagnose.js';

// Re-checking while the user types waits for a pause; above this size the
// bar only refreshes on the next Format (a full scan per pause is wasteful).
const RECHECK_DELAY_MS = 400;
const MAX_LIVE_RECHECK_CHARS = 2 * 1024 * 1024;

export function createIssueHelper({ syntaxEditor, getText, getMode, isPreview, isTree, showText, onFixed, onNext }) {
  const bar = document.querySelector('#issueBar');
  const title = document.querySelector('#issueTitle');
  const where = document.querySelector('#issueWhere');
  const hint = document.querySelector('#issueHint');
  const goBtn = document.querySelector('#issueGoBtn');
  const fixBtn = document.querySelector('#issueFixBtn');
  const closeBtn = document.querySelector('#issueCloseBtn');
  if (!bar || !syntaxEditor?.showIssue) {
    return { check() { return null; }, hide() {}, edited() {}, current: () => null };
  }

  let current = null;
  let timer = 0;
  // A fix is being applied: its own 'input' event must not schedule a
  // second check on top of the immediate one.
  let applying = false;

  goBtn.addEventListener('click', () => {
    if (!current) return;
    if (isTree()) showText();
    syntaxEditor.reveal(current.from);
  });
  fixBtn.addEventListener('click', () => {
    if (!current?.fix) return;
    const { fix } = current;
    applying = true;
    try {
      syntaxEditor.applyChanges(fix.changes);
    } finally {
      applying = false;
    }
    const next = check();
    if (next) {
      syntaxEditor.reveal(next.from);
      onNext?.(next);
    } else {
      onFixed?.(fix);
    }
  });
  closeBtn?.addEventListener('click', hide);

  function hide() {
    clearTimeout(timer);
    current = null;
    bar.hidden = true;
    syntaxEditor.showIssue(null);
  }

  // Diagnoses the visible payload; shows the bar for the first problem or
  // hides it when there is none. Returns the issue (or null).
  function check() {
    clearTimeout(timer);
    const text = getText();
    if (!text || isPreview()) {
      hide();
      return null;
    }
    // Strict detection gives up on stray text before the payload; the
    // lenient guess still finds the JSON or XML so the bar can explain it.
    const issue = diagnose(text, getMode(text) || guessMode(text));
    if (!issue) {
      hide();
      return null;
    }
    show(issue);
    return issue;
  }

  function show(issue) {
    current = issue;
    title.textContent = issue.message;
    where.textContent = `Line ${issue.line.toLocaleString()}, column ${issue.col.toLocaleString()}`;
    hint.textContent = issue.hint || '';
    goBtn.textContent = `Go to line ${issue.line.toLocaleString()}`;
    fixBtn.hidden = !issue.fix;
    fixBtn.textContent = issue.fix ? issue.fix.label : '';
    fixBtn.title = issue.fix ? 'Apply this fix' : '';
    bar.hidden = false;
    syntaxEditor.showIssue(issue);
  }

  // The user edited the payload: the marked spot may have moved, so re-check
  // after a pause while the bar is showing.
  function edited() {
    if (!current || applying) return;
    clearTimeout(timer);
    if (getText().length > MAX_LIVE_RECHECK_CHARS) return;
    timer = setTimeout(check, RECHECK_DELAY_MS);
  }

  return { check, hide, edited, current: () => current };
}
