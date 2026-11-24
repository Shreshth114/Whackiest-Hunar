let openChoice;
let nextId = 0;
const installed = new WeakSet();

function el(name, className, text) {
  const node = document.createElement(name);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function closeChoices() {
  openChoice?.close();
}

export function choicePlacement(rect, viewport, desiredHeight) {
  const gutter = 10;
  const gap = 7;
  const width = Math.max(0, Math.min(Math.max(rect.width, 172), viewport.width - gutter * 2));
  const left = Math.max(gutter, Math.min(rect.left, viewport.width - gutter - width));
  const below = Math.max(0, viewport.height - rect.bottom - gap - gutter);
  const above = Math.max(0, rect.top - gap - gutter);
  const up = below < Math.min(desiredHeight, 205) && above > below;
  const height = Math.min(desiredHeight, up ? above : below);
  return { left, width, height, up, top:up ? rect.top - gap - height : rect.bottom + gap };
}

function enhance(select) {
  if (installed.has(select) || select.multiple || select.size > 1 || select.disabled ||
      !select.options.length || [...select.children].some(child => child.tagName === 'OPTGROUP')) return;
  installed.add(select);
  const picker = el('div', 'choice');
  const button = el('button', 'choice-trigger');
  const current = el('span', 'choice-value');
  const chevron = el('span', 'choice-chevron');
  const error = el('span', 'choice-error', 'Choose an option.');
  const id = 'choice-' + (++nextId);
  const popupId = id + '-list';
  const label = select.labels?.[0];
  const labelText = select.getAttribute('aria-label') || (label ? label.textContent.replace(select.textContent, '').trim() : '');
  const heading = select.dataset.choiceHeading;
  if (heading) picker.classList.add('choice-account');

  button.type = 'button';
  button.id = id;
  button.setAttribute('role', 'combobox');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  chevron.setAttribute('aria-hidden', 'true');
  error.id = id + '-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const buttonContent = el('span', 'choice-content');
  if (heading) buttonContent.append(el('span','choice-heading',heading));
  buttonContent.append(current);
  button.append(buttonContent, chevron);
  if (label) label.htmlFor = button.id;
  select.before(picker);
  picker.append(button, error, select);
  select.classList.add('choice-native');
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  let list;
  let rows = [];
  let active = -1;
  let query = '';
  let lastTyped = 0;

  function update() {
    const selected = select.selectedOptions[0]?.text.trim() || 'Choose an option';
    current.textContent = selected;
    button.setAttribute('aria-label', labelText ? labelText + ', ' + selected : selected);
    if (select.validity.valid) {
      error.hidden = true;
      button.removeAttribute('aria-invalid');
      button.removeAttribute('aria-describedby');
    }
  }

  function position() {
    if (!list) return;
    const rect = button.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight || !button.isConnected) { close(); return; }
    const desired = Math.min(300,list.scrollHeight + list.offsetHeight - list.clientHeight);
    const layout = choicePlacement(rect,{width:document.documentElement.clientWidth,height:window.innerHeight},desired);
    Object.assign(list.style,{
      left:layout.left + 'px', width:layout.width + 'px', top:layout.top + 'px', maxHeight:layout.height + 'px'
    });
    list.classList.toggle('above',layout.up);
  }

  function mark(index, reveal = true) {
    if (!rows[index]) return;
    rows[active]?.node.classList.remove('current');
    active = index;
    const row = rows[index].node;
    row.classList.add('current');
    button.setAttribute('aria-activedescendant', row.id);
    if (reveal) {
      const top = row.offsetTop - list.scrollTop;
      if (top < 4) list.scrollTop = row.offsetTop - 4;
      else if (top + row.offsetHeight > list.clientHeight - 4) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 4;
    }
  }

  function open(direction = 1) {
    if (list) return;
    closeChoices();
    list = el('div','choice-menu');
    list.id = popupId;
    list.setAttribute('role','listbox');
    list.setAttribute('aria-label',labelText || 'Options');
    rows = [];
    [...select.options].forEach((option,index) => {
      if (option.hidden) return;
      const row = el('div','choice-option',option.text.trim());
      row.id = popupId + '-' + index;
      row.setAttribute('role','option');
      row.setAttribute('aria-selected', String(index === select.selectedIndex));
      if (option.disabled) row.setAttribute('aria-disabled','true');
      const rowIndex = rows.push({node:row,option,index}) - 1;
      row.addEventListener('pointermove', () => { if (!option.disabled) mark(rowIndex,false); });
      row.addEventListener('click', () => choose(rowIndex));
      list.append(row);
    });
    if (!rows.some(row => !row.option.disabled)) { list = undefined; return; }
    list.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse') event.preventDefault(); });
    document.body.append(list);
    openChoice = {close, picker, list, position};
    button.setAttribute('aria-expanded','true');
    button.setAttribute('aria-controls',popupId);
    position();
    const selected = rows.findIndex(row => row.index === select.selectedIndex && !row.option.disabled);
    const initial = selected === -1 ? edge(direction) : selected;
    mark(initial);
    query = '';
  }

  function close() {
    if (!list) return;
    list.remove();
    list = undefined;
    rows = [];
    active = -1;
    button.setAttribute('aria-expanded','false');
    button.removeAttribute('aria-controls');
    button.removeAttribute('aria-activedescendant');
    openChoice = undefined;
  }

  function edge(direction) {
    return direction < 0 ? rows.findLastIndex(row => !row.option.disabled) : rows.findIndex(row => !row.option.disabled);
  }

  function advance(direction) {
    for (let index = active + direction; index >= 0 && index < rows.length; index += direction) {
      if (!rows[index].option.disabled) { mark(index); return; }
    }
  }

  function choose(index) {
    const row = rows[index];
    if (!row || row.option.disabled) return;
    const changed = select.selectedIndex !== row.index;
    select.selectedIndex = row.index;
    close();
    button.focus({preventScroll:true});
    update();
    if (changed) {
      select.dispatchEvent(new Event('input',{bubbles:true}));
      select.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }

  button.addEventListener('click', () => list ? close() : open());
  button.addEventListener('keydown', event => {
    const key = event.key;
    if (key === 'Tab') { close(); return; }
    if (key === 'Escape' && list) { event.preventDefault(); close(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const direction = key === 'ArrowDown' ? 1 : -1;
      if (list) advance(direction);
      else open(direction);
      return;
    }
    if (key === 'Home' || key === 'End') {
      if (!list) return;
      event.preventDefault();
      mark(edge(key === 'Home' ? 1 : -1));
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (list) choose(active);
      else open();
      return;
    }
    if (key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey || !key.trim()) return;
    if (!list) open();
    if (!list) return;
    const now = Date.now();
    query = (now - lastTyped > 600 ? '' : query) + key.toLocaleLowerCase();
    lastTyped = now;
    let match = rows.findIndex(row => !row.option.disabled && row.option.text.trim().toLocaleLowerCase().startsWith(query));
    if (match < 0 && query.length > 1 && [...query].every(letter => letter === query[0])) {
      for (let offset = 1; offset <= rows.length; offset++) {
        const index = (active + offset) % rows.length;
        if (!rows[index].option.disabled && rows[index].option.text.trim().toLocaleLowerCase().startsWith(query[0])) { match = index; break; }
      }
    }
    if (match >= 0) { event.preventDefault(); mark(match); }
  });
  select.addEventListener('change', update);
  select.addEventListener('invalid', event => {
    event.preventDefault();
    error.hidden = false;
    button.setAttribute('aria-invalid','true');
    button.setAttribute('aria-describedby',error.id);
    if (!select.form || [...select.form.elements].find(field => field.willValidate && !field.validity.valid) === select) button.focus();
  });
  select.form?.addEventListener('reset', () => queueMicrotask(update));
  update();
}

export function enhanceChoices(root) {
  root.querySelectorAll('select').forEach(enhance);
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', event => {
    if (openChoice && !openChoice.picker.contains(event.target) && !openChoice.list.contains(event.target)) closeChoices();
  });
  document.addEventListener('focusin', event => {
    if (openChoice && !openChoice.picker.contains(event.target)) closeChoices();
  });
  window.addEventListener('resize', () => openChoice?.position());
  window.addEventListener('scroll', event => {
    if (openChoice && event.target !== openChoice.list) openChoice.position();
  }, {capture:true,passive:true});
}
