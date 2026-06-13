(() => {
  const LABEL_CLASS = 'dodo-quizlet-index-label';
  const INDEXED_TERM_CLASS = 'dodo-quizlet-indexed-term';
  const INDEXED_ROW_CLASS = 'dodo-quizlet-indexed-row';
  const WORD_TEXT_SELECTOR = '[data-testid="TermText"], [data-testid="set-page-card-side-word-text"]';
  const ROW_SELECTOR = '[data-testid="SetPageTerm-content"], [data-testid="SetPageTerm-card"], [class*="SetPageTerm"]';

  const getWordElement = (row) => {
    const exactMatch = row.querySelector(WORD_TEXT_SELECTOR);
    if (exactMatch) {
      return exactMatch;
    }

    const textCandidates = Array.from(row.querySelectorAll('a, span, div'))
      .filter((element) => {
        const text = element.textContent.trim();
        return text && text.length <= 80 && !element.querySelector('a, span, div');
      });

    return textCandidates[0] || null;
  };

  const getTermRows = () => {
    const rows = Array.from(document.querySelectorAll(ROW_SELECTOR))
      .filter((row) => row.textContent.trim().length > 0);

    if (rows.length > 0) {
      return rows;
    }

    return Array.from(document.querySelectorAll('[data-testid]'))
      .filter((element) => /term/i.test(element.getAttribute('data-testid') || ''))
      .filter((element) => getWordElement(element));
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
    if (rows.length === 0) {
      return;
    }

    clearStaleLabels();

    rows.forEach((row, index) => {
      const wordElement = getWordElement(row);
      if (!wordElement) {
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

  const debounce = (fn, wait) => {
    let timeoutId;
    return () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(fn, wait);
    };
  };

  const refreshLabels = debounce(addLabels, 250);

  addLabels();

  const observer = new MutationObserver(refreshLabels);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
