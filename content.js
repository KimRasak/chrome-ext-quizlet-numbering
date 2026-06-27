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
  const PAGE_HIDDEN_CLASS = 'dodo-quizlet-row--hidden';
  const PAGE_SIZE = 100;
  const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
  const WORD_TEXT_SELECTOR = '[data-testid="TermText"], [data-testid="set-page-card-side-word-text"], .TermText';
  const ROW_SELECTOR = '[data-testid="SetPageTerm-content"], [data-testid="SetPageTerm-card"], [data-testid="set-page-term-card"], .SetPageTermsList-term, [class*="SetPageTermsList-term"]';
  const DEFAULT_EXPORT_LABEL = 'Export words';
  const DEFAULT_JUMP_LABEL = 'Jump';
  const JUMP_WAIT_MS = 350;
  const MAX_JUMP_ATTEMPTS = 24;
  const MAX_STALLED_ATTEMPTS = 3;
  const MAX_WORD_TEXT_LENGTH = 120;
  const MIN_RENDERED_ROWS_FOR_PANEL = 1;
  const LABEL_VIEWPORT_BUFFER = window.innerHeight * 2;
  let exportFeedbackTimeoutId;
  let jumpFeedbackTimeoutId;
  let highlightTimeoutId;
  let observer;
  let jumpSearchInProgress = false;
  let exportInProgress = false;
  // Map from row element -> assigned 1-based index (persists across scroll)
  const rowIndexMap = new WeakMap();
  let globalRowCounter = 0;
  let currentPage = 1;

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

  const getTotalWordCount = () => {
    const headings = Array.from(document.querySelectorAll('span, h2'));
    for (const el of headings) {
      const match = el.textContent.match(/\((\d+)\)$/);
      if (match && el.textContent.length < 60) {
        return Number.parseInt(match[1], 10);
      }
    }
    return 0;
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

  // --- Pagination helpers ---

  const getTotalPages = () => {
    const total = getTotalWordCount();
    return total > 0 ? Math.ceil(total / PAGE_SIZE) : 0;
  };

  const applyPageVisibility = (rows) => {
    const start = (currentPage - 1) * PAGE_SIZE; // 0-based
    rows.forEach((row, i) => {
      const globalIndex = rowIndexMap.get(row) ?? (i + 1);
      const onPage = globalIndex > start && globalIndex <= start + PAGE_SIZE;
      row.classList.toggle(PAGE_HIDDEN_CLASS, !onPage);
    });
  };

  const updatePaginationButtons = () => {
    const total = getTotalWordCount();
    if (total === 0) {
      return;
    }

    const totalPages = Math.ceil(total / PAGE_SIZE);
    const prevBtn = document.querySelector('.dodo-quizlet-prev-button');
    const nextBtn = document.querySelector('.dodo-quizlet-next-button');
    const pageLabel = document.querySelector('.dodo-quizlet-page-label');

    if (prevBtn) {
      prevBtn.disabled = currentPage <= 1;
    }

    if (nextBtn) {
      nextBtn.disabled = currentPage >= totalPages;
    }

    if (pageLabel) {
      pageLabel.textContent = `${currentPage}/${totalPages}`;
    }
  };

  const goToPage = (page) => {
    const total = getTotalWordCount();
    if (total === 0) {
      return;
    }

    const totalPages = Math.ceil(total / PAGE_SIZE);
    currentPage = Math.max(1, Math.min(page, totalPages));

    const rows = getTermRows();
    applyPageVisibility(rows);
    updatePaginationButtons();

    // Scroll to top of list
    const firstVisible = rows.find((row) => !row.classList.contains(PAGE_HIDDEN_CLASS));
    if (firstVisible) {
      firstVisible.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const isNearViewport = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -LABEL_VIEWPORT_BUFFER && rect.top <= window.innerHeight + LABEL_VIEWPORT_BUFFER;
  };

  const addLabels = () => {
    const rows = getTermRows();
    if (rows.length === 0) {
      return;
    }

    // Assign stable indices to newly seen rows
    rows.forEach((row) => {
      if (!rowIndexMap.has(row)) {
        globalRowCounter += 1;
        rowIndexMap.set(row, globalRowCounter);
      }
    });

    // Apply page visibility whenever rows are refreshed
    if (getTotalWordCount() > PAGE_SIZE) {
      applyPageVisibility(rows);
      updatePaginationButtons();
    }

    // Only label rows near the viewport; remove labels from far-away rows
    rows.forEach((row) => {
      const wordElement = getWordElement(row);
      if (!wordElement || isRowEditable(row)) {
        return;
      }

      const existingLabel = wordElement.querySelector(`.${LABEL_CLASS}`);

      if (!isNearViewport(row)) {
        // Outside viewport buffer: remove label to save DOM nodes
        if (existingLabel) {
          existingLabel.remove();
          wordElement.classList.remove(INDEXED_TERM_CLASS);
          row.classList.remove(INDEXED_ROW_CLASS);
        }
        return;
      }

      // Inside viewport buffer: ensure label is present and correct
      const index = rowIndexMap.get(row);
      if (existingLabel) {
        if (existingLabel.textContent !== String(index)) {
          existingLabel.textContent = String(index);
          existingLabel.title = `No. ${index} in this Quizlet word list`;
        }
        return;
      }

      const label = document.createElement('span');
      label.className = LABEL_CLASS;
      label.textContent = String(index);
      label.title = `No. ${index} in this Quizlet word list`;

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
    const totalCount = getTotalWordCount();
    let attempts = 0;
    let stalledAttempts = 0;

    while (attempts < MAX_JUMP_ATTEMPTS && stalledAttempts < MAX_STALLED_ATTEMPTS) {
      if (totalCount > 0 && collectedLines.size >= totalCount) {
        break;
      }

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

      const progress = totalCount > 0
        ? `${collectedLines.size}/${totalCount}`
        : String(collectedLines.size);

      if (collectedLines.size > previousCount) {
        stalledAttempts = 0;
        setExportButtonLabel(`Scanning ${progress}...`);
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
    const totalCount = getTotalWordCount();
    setExportButtonLabel(totalCount > 0 ? `Scanning 0/${totalCount}...` : 'Scanning...');

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

    // Show/hide pagination nav based on total word count
    const pageNav = panel.querySelector('.dodo-quizlet-page-nav');
    if (pageNav) {
      const total = getTotalWordCount();
      pageNav.style.display = total > PAGE_SIZE ? '' : 'none';
      if (total > PAGE_SIZE) {
        updatePaginationButtons();
      }
    }
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

    // Pagination controls (shown only when list > PAGE_SIZE)
    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'dodo-quizlet-prev-button';
    prevButton.textContent = '‹';
    prevButton.title = 'Previous page';
    prevButton.setAttribute('aria-label', 'Previous page');
    prevButton.addEventListener('click', () => goToPage(currentPage - 1));

    const pageLabel = document.createElement('span');
    pageLabel.className = 'dodo-quizlet-page-label';

    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'dodo-quizlet-next-button';
    nextButton.textContent = '›';
    nextButton.title = 'Next page';
    nextButton.setAttribute('aria-label', 'Next page');
    nextButton.addEventListener('click', () => goToPage(currentPage + 1));

    const pageNav = document.createElement('div');
    pageNav.className = 'dodo-quizlet-page-nav';
    pageNav.append(prevButton, pageLabel, nextButton);

    panel.append(jumpInput, jumpButton, exportButton, pageNav);
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

    // Re-label on scroll so near-viewport labels stay current
    window.addEventListener('scroll', scheduleRefreshUi, { passive: true });
  };

  if (document.body) {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
