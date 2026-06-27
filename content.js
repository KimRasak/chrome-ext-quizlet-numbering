(() => {
  const LABEL_CLASS = 'dodo-quizlet-index-label';
  const INDEXED_TERM_CLASS = 'dodo-quizlet-indexed-term';
  const INDEXED_ROW_CLASS = 'dodo-quizlet-indexed-row';
  const HIGHLIGHTED_ROW_CLASS = 'dodo-quizlet-highlighted-row';
  const CONTROL_PANEL_CLASS = 'dodo-quizlet-control-panel';
  const CONTROL_INPUT_CLASS = 'dodo-quizlet-jump-input';
  const JUMP_BUTTON_CLASS = 'dodo-quizlet-jump-button';
  const EXPORT_BUTTON_CLASS = 'dodo-quizlet-export-button';
  const PANEL_HIDDEN_CLASS = 'dodo-quizlet-control-panel--hidden';
  const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
  const WORD_TEXT_SELECTOR = '[data-testid="TermText"], [data-testid="set-page-card-side-word-text"], .TermText';
  const ROW_SELECTOR = '[data-testid="SetPageTerm-content"], [data-testid="SetPageTerm-card"], [data-testid="set-page-term-card"], .SetPageTermsList-term, [class*="SetPageTermsList-term"]';
  const DEFAULT_EXPORT_LABEL = 'Export words';
  const DEFAULT_JUMP_LABEL = 'Jump';
  const JUMP_WAIT_MS = 700;
  const MAX_JUMP_ATTEMPTS = 18;
  const MAX_STALLED_ATTEMPTS = 4;
  const MAX_WORD_TEXT_LENGTH = 120;
  const MIN_RENDERED_ROWS_FOR_PANEL = 1;
  let exportFeedbackTimeoutId;
  let jumpFeedbackTimeoutId;
  let highlightTimeoutId;
  let observer;
  let jumpSearchInProgress = false;
  let exportInProgress = false;

  const wait = (delay) => new Promise((resolve) => {
    window.setTimeout(resolve, delay);
  });

  const runSafely = (fn) => {
    try {
      return fn();
    } catch (error) {
      console.warn('Quizlet numbering skipped an unsafe UI update.', error);
      return undefined;
    }
  };

  const isElementVisible = (element) => {
    if (!(element instanceof Element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const getUniqueElements = (elements) => Array.from(new Set(elements));

  const isEditableElement = (element) => {
    if (!(element instanceof Element)) {
      return false;
    }

    return Boolean(element.closest('input, textarea, [contenteditable]:not([contenteditable="false"])'));
  };

  const getWordElement = (row) => {
    const exactMatches = Array.from(row.querySelectorAll(WORD_TEXT_SELECTOR))
      .filter((element) => !element.classList.contains(LABEL_CLASS))
      .filter((element) => isElementVisible(element) || element.textContent.trim());

    if (exactMatches.length > 0) {
      return exactMatches[0];
    }

    const textCandidates = Array.from(row.querySelectorAll('a, span'))
      .filter((element) => {
        if (element.classList.contains(LABEL_CLASS) || isEditableElement(element)) {
          return false;
        }

        const text = element.textContent.trim();
        return text
          && text.length <= MAX_WORD_TEXT_LENGTH
          && !/^\d+$/.test(text)
          && !element.querySelector('a, span, div')
          && (isElementVisible(element) || text);
      })
      .sort((leftElement, rightElement) => rightElement.textContent.trim().length - leftElement.textContent.trim().length);

    return textCandidates[0] || null;
  };

  const isRowEditable = (row) => {
    const wordElement = getWordElement(row);
    if (wordElement && isEditableElement(wordElement)) {
      return true;
    }

    return Boolean(row.querySelector(EDITABLE_SELECTOR));
  };

  const getCleanTextFromElement = (element) => {
    if (!element) {
      return '';
    }

    const clonedElement = element.cloneNode(true);
    clonedElement.querySelectorAll(`.${LABEL_CLASS}`).forEach((label) => label.remove());

    return clonedElement.textContent.replace(/\s+/g, ' ').trim();
  };

  const getWordText = (row) => {
    const wordElement = getWordElement(row);
    if (!wordElement || isEditableElement(wordElement)) {
      return '';
    }

    return getCleanTextFromElement(wordElement);
  };

  const hasWordContent = (row) => Boolean(getWordElement(row) || row.querySelector(EDITABLE_SELECTOR));

  const hasExactWordElement = (row) => Boolean(row.querySelector(WORD_TEXT_SELECTOR));

  const isNestedInsideAnotherRow = (row, rows) => rows.some((candidate) => candidate !== row && candidate.contains(row));

  const getStableRows = (selector) => {
    const rows = getUniqueElements(Array.from(document.querySelectorAll(selector)))
      .filter((row) => row instanceof HTMLElement)
      .filter((row) => !row.closest(`.${CONTROL_PANEL_CLASS}`))
      .filter((row) => isElementVisible(row) || hasWordContent(row));

    return rows.filter((row) => !isNestedInsideAnotherRow(row, rows));
  };

  const getTermRows = () => {
    const rows = getStableRows(ROW_SELECTOR);
    const exactRows = rows.filter((row) => hasExactWordElement(row));

    if (exactRows.length > 0) {
      return exactRows;
    }

    const fallbackRows = rows.filter((row) => hasWordContent(row));
    if (fallbackRows.length > 0) {
      return fallbackRows;
    }

    const testIdRows = getStableRows('[data-testid]')
      .filter((element) => /(^|[-_])term([-_]|$)/i.test(element.getAttribute('data-testid') || ''))
      .filter((element) => hasWordContent(element));

    return testIdRows.filter((row) => !isNestedInsideAnotherRow(row, testIdRows));
  };

  const getRenderedExportRows = () => getStableRows('.SetPageTermsList-term, [class*="SetPageTermsList-term"]');

  const getCardSideText = (row, index) => {
    const cardSides = Array.from(row.querySelectorAll('[data-testid="set-page-term-card-side"]'));
    const cardSide = cardSides[index];
    if (!cardSide) {
      return '';
    }

    const exactTextElement = cardSide.querySelector('.TermText');
    if (exactTextElement && !isEditableElement(exactTextElement)) {
      return getCleanTextFromElement(exactTextElement);
    }

    return '';
  };

  const getExportLine = (row) => {
    const termText = getCardSideText(row, 0);
    const definitionText = getCardSideText(row, 1);

    if (termText && definitionText) {
      return `${termText}\t${definitionText}`;
    }

    return '';
  };

  const extractWords = () => {
    const seenLines = new Set();

    return getRenderedExportRows()
      .map((row) => getExportLine(row))
      .filter(Boolean)
      .filter((line) => {
        if (seenLines.has(line)) {
          return false;
        }

        seenLines.add(line);
        return true;
      });
  };

  const clearStaleLabels = () => {
    document.querySelectorAll(`.${LABEL_CLASS}`).forEach((label) => label.remove());
    document.querySelectorAll(`.${INDEXED_TERM_CLASS}`).forEach((element) => {
      element.classList.remove(INDEXED_TERM_CLASS);
    });
    document.querySelectorAll(`.${INDEXED_ROW_CLASS}`).forEach((element) => {
      element.classList.remove(INDEXED_ROW_CLASS);
    });
  };

  const addLabels = () => {
    const rows = getTermRows();
    clearStaleLabels();

    if (rows.length === 0) {
      return;
    }

    rows.forEach((row, index) => {
      const wordElement = getWordElement(row);
      if (!wordElement || isRowEditable(row)) {
        return;
      }

      const label = document.createElement('span');
      label.className = LABEL_CLASS;
      label.textContent = String(index + 1);
      label.title = `No. ${index + 1} in this Quizlet word list`;

      row.classList.add(INDEXED_ROW_CLASS);
      wordElement.classList.add(INDEXED_TERM_CLASS);
      wordElement.prepend(label);
    });
  };

  const getDownloadFilename = () => {
    const titleSlug = (document.title || '')
      .replace(/\s*\|\s*Quizlet\s*$/i, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return `${titleSlug || 'quizlet'}-words.txt`;
  };

  const downloadWords = (words) => {
    const file = new Blob([`${words.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(file);
    const link = document.createElement('a');

    link.href = downloadUrl;
    link.download = getDownloadFilename();
    link.style.display = 'none';

    document.body.append(link);
    link.click();
    link.remove();

    window.setTimeout(() => {
      URL.revokeObjectURL(downloadUrl);
    }, 0);
  };

  const getJumpInput = () => document.querySelector(`.${CONTROL_INPUT_CLASS}`);

  const getJumpButton = () => document.querySelector(`.${JUMP_BUTTON_CLASS}`);

  const getExportButton = () => document.querySelector(`.${EXPORT_BUTTON_CLASS}`);

  const setJumpControlsDisabled = (disabled) => {
    const input = getJumpInput();
    const button = getJumpButton();

    if (input) {
      input.disabled = disabled;
    }

    if (button) {
      button.disabled = disabled;
    }
  };

  const setExportControlsDisabled = (disabled) => {
    const button = getExportButton();
    if (button) {
      button.disabled = disabled;
    }
  };

  const setButtonLabel = (buttonClass, label, defaultLabel, resetDelay = 0) => {
    const button = document.querySelector(`.${buttonClass}`);
    if (!button) {
      return;
    }

    button.textContent = label;

    const timeoutKey = buttonClass === EXPORT_BUTTON_CLASS ? 'export' : 'jump';
    const currentTimeoutId = timeoutKey === 'export' ? exportFeedbackTimeoutId : jumpFeedbackTimeoutId;

    if (currentTimeoutId) {
      window.clearTimeout(currentTimeoutId);
    }

    if (resetDelay > 0) {
      const nextTimeoutId = window.setTimeout(() => {
        button.textContent = defaultLabel;
      }, resetDelay);

      if (timeoutKey === 'export') {
        exportFeedbackTimeoutId = nextTimeoutId;
      } else {
        jumpFeedbackTimeoutId = nextTimeoutId;
      }

      return;
    }

    if (timeoutKey === 'export') {
      exportFeedbackTimeoutId = undefined;
    } else {
      jumpFeedbackTimeoutId = undefined;
    }
  };

  const setExportButtonLabel = (label, resetDelay = 0) => {
    setButtonLabel(EXPORT_BUTTON_CLASS, label, DEFAULT_EXPORT_LABEL, resetDelay);
  };

  const setJumpButtonLabel = (label, resetDelay = 0) => {
    setButtonLabel(JUMP_BUTTON_CLASS, label, DEFAULT_JUMP_LABEL, resetDelay);
  };

  const clearHighlightedRow = () => {
    document.querySelectorAll(`.${HIGHLIGHTED_ROW_CLASS}`).forEach((row) => {
      row.classList.remove(HIGHLIGHTED_ROW_CLASS);
    });

    if (highlightTimeoutId) {
      window.clearTimeout(highlightTimeoutId);
      highlightTimeoutId = undefined;
    }
  };

  const highlightRow = (row) => {
    clearHighlightedRow();
    row.classList.add(HIGHLIGHTED_ROW_CLASS);
    highlightTimeoutId = window.setTimeout(() => {
      row.classList.remove(HIGHLIGHTED_ROW_CLASS);
      highlightTimeoutId = undefined;
    }, 2000);
  };

  const findRenderedTargetRow = (targetIndex) => {
    const rows = getTermRows();
    return {
      rows,
      targetRow: rows[targetIndex - 1] || null,
    };
  };

  const scrollForMoreRows = async (targetIndex) => {
    let attempts = 0;
    let stalledAttempts = 0;

    while (attempts < MAX_JUMP_ATTEMPTS && stalledAttempts < MAX_STALLED_ATTEMPTS) {
      const { rows, targetRow } = findRenderedTargetRow(targetIndex);
      if (targetRow) {
        return { rows, targetRow, reachedEnd: false };
      }

      if (rows.length === 0) {
        break;
      }

      const previousRowCount = rows.length;
      const lastRow = rows[rows.length - 1];
      lastRow.scrollIntoView({ behavior: 'auto', block: 'end' });
      await wait(JUMP_WAIT_MS);

      const updatedRows = getTermRows();
      if (updatedRows[targetIndex - 1]) {
        return { rows: updatedRows, targetRow: updatedRows[targetIndex - 1], reachedEnd: false };
      }

      if (updatedRows.length > previousRowCount) {
        stalledAttempts = 0;
      } else {
        stalledAttempts += 1;
      }

      attempts += 1;
    }

    const finalRows = getTermRows();
    return {
      rows: finalRows,
      targetRow: finalRows[targetIndex - 1] || null,
      reachedEnd: true,
    };
  };

  const collectAllExportLines = async () => {
    const collectedLines = new Set(extractWords());
    let attempts = 0;
    let stalledAttempts = 0;

    while (attempts < MAX_JUMP_ATTEMPTS && stalledAttempts < MAX_STALLED_ATTEMPTS) {
      const rows = getRenderedExportRows();
      if (rows.length === 0) {
        break;
      }

      const previousCount = collectedLines.size;
      const lastRow = rows[rows.length - 1];
      lastRow.scrollIntoView({ behavior: 'auto', block: 'end' });
      await wait(JUMP_WAIT_MS);

      extractWords().forEach((line) => {
        collectedLines.add(line);
      });

      if (collectedLines.size > previousCount) {
        stalledAttempts = 0;
        setExportButtonLabel(`Scanning ${collectedLines.size}...`);
      } else {
        stalledAttempts += 1;
      }

      attempts += 1;
    }

    return Array.from(collectedLines);
  };

  const handleExportClick = async () => {
    if (exportInProgress) {
      return;
    }

    exportInProgress = true;
    setExportControlsDisabled(true);
    setExportButtonLabel('Scanning...');

    try {
      const words = await collectAllExportLines();

      if (words.length === 0) {
        setExportButtonLabel('No words found', 1800);
        return;
      }

      downloadWords(words);
      setExportButtonLabel(`Downloaded ${words.length}`, 2200);
    } finally {
      exportInProgress = false;
      setExportControlsDisabled(false);
    }
  };

  const handleJumpClick = async () => {
    if (jumpSearchInProgress) {
      return;
    }

    const input = getJumpInput();
    if (!input) {
      return;
    }

    const targetIndex = Number.parseInt(input.value, 10);
    if (!Number.isInteger(targetIndex) || targetIndex < 1) {
      setJumpButtonLabel('Invalid #', 1800);
      return;
    }

    jumpSearchInProgress = true;
    setJumpControlsDisabled(true);
    setJumpButtonLabel('Searching...');

    try {
      let { rows, targetRow } = findRenderedTargetRow(targetIndex);

      if (!targetRow) {
        const searchResult = await scrollForMoreRows(targetIndex);
        rows = searchResult.rows;
        targetRow = searchResult.targetRow;
      }

      if (!targetRow) {
        setJumpButtonLabel(rows.length > 0 ? `Only ${rows.length}` : 'Reached end', 2200);
        return;
      }

      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      highlightRow(targetRow);
      setJumpButtonLabel(`Row ${targetIndex}`, 1800);
    } finally {
      jumpSearchInProgress = false;
      setJumpControlsDisabled(false);
    }
  };

  const handleJumpInputKeydown = (event) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    void handleJumpClick();
  };

  const shouldShowControlPanel = () => getTermRows().length >= MIN_RENDERED_ROWS_FOR_PANEL || getRenderedExportRows().length >= MIN_RENDERED_ROWS_FOR_PANEL;

  const setControlPanelVisibility = () => {
    const panel = document.querySelector(`.${CONTROL_PANEL_CLASS}`);
    if (!panel) {
      return;
    }

    panel.classList.toggle(PANEL_HIDDEN_CLASS, !shouldShowControlPanel());
  };

  const ensureControlPanel = () => {
    if (!document.body || document.querySelector(`.${CONTROL_PANEL_CLASS}`)) {
      return;
    }

    const panel = document.createElement('div');
    panel.className = CONTROL_PANEL_CLASS;
    panel.setAttribute('aria-label', 'Quizlet word tools');

    const jumpInput = document.createElement('input');
    jumpInput.type = 'number';
    jumpInput.min = '1';
    jumpInput.placeholder = 'Go to #';
    jumpInput.className = CONTROL_INPUT_CLASS;
    jumpInput.title = 'Enter a word number';
    jumpInput.inputMode = 'numeric';
    jumpInput.autocomplete = 'off';
    jumpInput.setAttribute('aria-label', 'Word number');
    jumpInput.addEventListener('keydown', handleJumpInputKeydown);

    const jumpButton = document.createElement('button');
    jumpButton.type = 'button';
    jumpButton.className = JUMP_BUTTON_CLASS;
    jumpButton.textContent = DEFAULT_JUMP_LABEL;
    jumpButton.title = 'Jump to a specific word number';
    jumpButton.setAttribute('aria-label', 'Jump to word number');
    jumpButton.addEventListener('click', () => {
      void handleJumpClick();
    });

    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.className = EXPORT_BUTTON_CLASS;
    exportButton.textContent = DEFAULT_EXPORT_LABEL;
    exportButton.title = 'Download all words from this Quizlet list';
    exportButton.setAttribute('aria-label', 'Export Quizlet words');
    exportButton.addEventListener('click', () => {
      void handleExportClick();
    });

    panel.append(jumpInput, jumpButton, exportButton);
    document.body.append(panel);
    setControlPanelVisibility();
  };

  const debounce = (fn, waitMs) => {
    let timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(fn, waitMs);
    };
  };

  const refreshUi = () => {
    if (!document.body) {
      return;
    }

    if (observer) {
      observer.disconnect();
    }

    runSafely(() => {
      addLabels();
      ensureControlPanel();
      setControlPanelVisibility();
    });

    if (observer && document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  };

  const scheduleRefreshUi = debounce(refreshUi, 250);

  const start = () => {
    refreshUi();

    if (!document.body) {
      return;
    }

    observer = new MutationObserver(() => {
      scheduleRefreshUi();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  };

  if (document.body) {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
