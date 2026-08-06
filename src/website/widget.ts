/**
 * The booking widget embedded in every generated website.
 *
 * Plain ES2017 with no build step and no dependencies, so a generated site is
 * a folder of static files that can be hosted anywhere — including on the
 * customer's existing web host.
 *
 * The condition evaluator here mirrors `domain/intake/schema.ts`. That is a
 * deliberate duplication: the grammar is four cases wide, and keeping the
 * browser copy inline avoids shipping a bundler to maintain a twenty-line
 * function. The server re-validates every answer on submit, so a divergence
 * would surface as a rejected booking rather than a bad one.
 */

/** Returned as a string and inlined into each generated page. */
export function bookingWidgetScript(): string {
  return String.raw`
(function () {
  'use strict';

  var root = document.getElementById('rth-bokun');
  if (!root) return;

  var api = root.getAttribute('data-api');
  var slug = root.getAttribute('data-slug');
  var state = {
    config: null,
    answers: {},
    service: null,
    extraMinutes: 0,
    date: null,
    slot: null,
    step: 'spurningar',
    days: [],
    weekOffset: 0,
    submitting: false
  };

  // -- helpers --------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (key) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function values(key) {
    var value = state.answers[key];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.filter(function (v) { return v !== ''; });
    return value === '' ? [] : [value];
  }

  // Mirrors evaluateCondition() on the server.
  function matches(condition) {
    if (!condition) return true;
    if (condition.all) return condition.all.every(matches);
    if (condition.any) return condition.any.some(matches);
    var current = values(condition.key);
    if (condition.answered) return current.length > 0;
    if (condition.equals !== undefined) return current.indexOf(condition.equals) !== -1;
    if (condition.oneOf) {
      return current.some(function (value) { return condition.oneOf.indexOf(value) !== -1; });
    }
    return true;
  }

  function visibleQuestions() {
    if (!state.config || !state.config.flow) return [];
    return state.config.flow.questions.filter(function (q) { return matches(q.showIf); });
  }

  function request(path, body) {
    return fetch(api + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data && data.skilabod ? data.skilabod : 'Eitthvað fór úrskeiðis.');
        return data;
      });
    });
  }

  function showError(message) {
    var box = root.querySelector('.rth-error');
    if (!box) return;
    box.textContent = message || '';
    box.style.display = message ? 'block' : 'none';
  }

  // -- step 1: questions ----------------------------------------------------

  function setAnswer(key, value) {
    state.answers[key] = value;
    // A changed answer can hide later branches, so their values are dropped.
    pruneHiddenAnswers();
    recalcDerived();
    renderQuestions();
  }

  function pruneHiddenAnswers() {
    if (!state.config || !state.config.flow) return;
    var allowed = {};
    visibleQuestions().forEach(function (q) { allowed[q.key] = true; });
    Object.keys(state.answers).forEach(function (key) {
      if (!allowed[key]) delete state.answers[key];
    });
  }

  function recalcDerived() {
    var extra = 0;
    var hint = null;
    visibleQuestions().forEach(function (question) {
      values(question.key).forEach(function (value) {
        var option = (question.options || []).filter(function (o) { return o.value === value; })[0];
        if (!option) return;
        if (option.addsMinutes) extra += option.addsMinutes;
        if (option.serviceHint && !hint) hint = option.serviceHint;
      });
    });
    state.extraMinutes = extra;

    if (hint) {
      var match = state.config.services.filter(function (s) {
        return normalise(s.name) === normalise(hint) || normalise(s.name).indexOf(normalise(hint)) !== -1;
      })[0];
      if (match) state.service = match;
    }
  }

  function normalise(value) {
    return String(value).toLowerCase().replace(/[^a-zþæðöáéíóúý0-9]/g, '');
  }

  function questionField(question) {
    var current = values(question.key);
    var body;

    if (question.type === 'val' || question.type === 'ja_nei') {
      var options = question.type === 'ja_nei'
        ? [{ value: 'ja', label: 'Já' }, { value: 'nei', label: 'Nei' }]
        : question.options || [];

      body = el('div', { class: 'rth-options' }, options.map(function (option) {
        var selected = current.indexOf(option.value) !== -1;
        return el('button', {
          type: 'button',
          class: 'rth-option' + (selected ? ' is-selected' : ''),
          onclick: function () { setAnswer(question.key, option.value); }
        }, [
          el('span', { class: 'rth-option-label', text: option.label }),
          option.description ? el('span', { class: 'rth-option-desc', text: option.description }) : null
        ]);
      }));
    } else if (question.type === 'fjolval') {
      body = el('div', { class: 'rth-options' }, (question.options || []).map(function (option) {
        var selected = current.indexOf(option.value) !== -1;
        return el('button', {
          type: 'button',
          class: 'rth-option' + (selected ? ' is-selected' : ''),
          onclick: function () {
            var next = current.slice();
            var index = next.indexOf(option.value);
            if (index === -1) next.push(option.value); else next.splice(index, 1);
            setAnswer(question.key, next);
          }
        }, [
          el('span', { class: 'rth-option-label', text: option.label }),
          option.description ? el('span', { class: 'rth-option-desc', text: option.description }) : null
        ]);
      }));
    } else if (question.type === 'langur_texti') {
      var textarea = el('textarea', {
        class: 'rth-input',
        rows: '4',
        placeholder: question.placeholder || '',
        maxlength: String(question.maxLength || 2000)
      });
      textarea.value = current[0] || '';
      textarea.addEventListener('change', function () { state.answers[question.key] = textarea.value; recalcDerived(); });
      body = el('div', {}, [textarea]);

      if (question.aiSuggest) {
        body.appendChild(suggestionBlock(question, textarea));
      }
    } else {
      var input = el('input', {
        class: 'rth-input',
        type: question.type === 'simi' ? 'tel' : question.type === 'dagsetning' ? 'date' : 'text',
        placeholder: question.placeholder || '',
        maxlength: String(question.maxLength || 200)
      });
      input.value = current[0] || '';
      if (question.type === 'bilnumer') input.style.textTransform = 'uppercase';
      input.addEventListener('change', function () { state.answers[question.key] = input.value; recalcDerived(); });
      body = el('div', {}, [input]);
    }

    return el('div', { class: 'rth-field', 'data-key': question.key }, [
      el('label', { class: 'rth-label' }, [
        question.label,
        question.required ? el('span', { class: 'rth-required', text: ' *' }) : null
      ]),
      question.help ? el('p', { class: 'rth-help', text: question.help }) : null,
      body,
      el('p', { class: 'rth-field-error', 'data-error-for': question.key })
    ]);
  }

  function suggestionBlock(question, textarea) {
    var wrap = el('div', { class: 'rth-suggest' });
    var button = el('button', {
      type: 'button',
      class: 'rth-btn rth-btn-ghost rth-btn-sm',
      text: 'Fá tillögur út frá lýsingunni'
    });
    var results = el('div', { class: 'rth-suggest-list' });

    button.addEventListener('click', function () {
      var description = textarea.value.trim();
      if (description.length < 3) {
        results.textContent = 'Skrifaðu fyrst stutta lýsingu.';
        return;
      }
      button.disabled = true;
      button.textContent = 'Sæki tillögur…';
      results.textContent = '';

      request('/tillogur', { slug: slug, subject: question.aiSuggest.subject, description: description })
        .then(function (data) {
          button.disabled = false;
          button.textContent = 'Fá fleiri tillögur';
          results.textContent = '';
          (data.tillogur || []).forEach(function (suggestion) {
            results.appendChild(el('button', {
              type: 'button',
              class: 'rth-suggestion',
              onclick: function () {
                textarea.value = suggestion.titill + ' — ' + suggestion.lysing;
                state.answers[question.key] = textarea.value;
              }
            }, [
              el('strong', { text: suggestion.titill }),
              el('span', { text: suggestion.lysing })
            ]));
          });
        })
        .catch(function () {
          button.disabled = false;
          button.textContent = 'Fá tillögur út frá lýsingunni';
          results.textContent = 'Ekki tókst að sækja tillögur. Haltu áfram — starfsmaður fer yfir lýsinguna.';
        });
    });

    wrap.appendChild(button);
    wrap.appendChild(results);
    return wrap;
  }

  function renderQuestions() {
    var container = root.querySelector('.rth-step-spurningar');
    if (!container) return;
    container.innerHTML = '';

    var questions = visibleQuestions();
    questions.forEach(function (question) { container.appendChild(questionField(question)); });

    var summary = el('div', { class: 'rth-summary' });
    if (state.service) {
      var minutes = state.service.durationMin + state.extraMinutes;
      summary.appendChild(el('span', { text: state.service.name }));
      summary.appendChild(el('span', { class: 'rth-dot', text: '·' }));
      summary.appendChild(el('span', { text: 'um það bil ' + minutes + ' mín.' }));
      if (state.service.priceIsk > 0) {
        summary.appendChild(el('span', { class: 'rth-dot', text: '·' }));
        summary.appendChild(el('span', { text: formatIsk(state.service.priceIsk) }));
      }
      container.appendChild(summary);
    }

    container.appendChild(el('div', { class: 'rth-actions' }, [
      el('button', { type: 'button', class: 'rth-btn rth-btn-primary', text: 'Sjá lausa tíma', onclick: goToTimes })
    ]));
  }

  function formatIsk(amount) {
    return String(Math.round(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' kr.';
  }

  // -- step 2: times --------------------------------------------------------

  function goToTimes() {
    showError('');
    clearFieldErrors();

    if (!state.service) {
      // No answer implied a service — let the customer choose one directly.
      if (state.config.services.length === 1) {
        state.service = state.config.services[0];
      } else {
        showError('Veldu þjónustu til að halda áfram.');
        return;
      }
    }

    request('/lausir-timar', {
      slug: slug,
      serviceId: state.service.id,
      extraMinutes: state.extraMinutes,
      vika: state.weekOffset,
      svor: state.answers
    })
      .then(function (data) {
        if (data.villur && Object.keys(data.villur).length > 0) {
          applyFieldErrors(data.villur);
          showError('Sumum spurningum er ósvarað.');
          return;
        }
        state.days = data.dagar || [];
        state.step = 'timi';
        render();
      })
      .catch(function (error) { showError(error.message); });
  }

  function clearFieldErrors() {
    Array.prototype.forEach.call(root.querySelectorAll('.rth-field-error'), function (node) {
      node.textContent = '';
    });
    Array.prototype.forEach.call(root.querySelectorAll('.rth-field'), function (node) {
      node.classList.remove('has-error');
    });
  }

  function applyFieldErrors(errors) {
    clearFieldErrors();
    Object.keys(errors).forEach(function (key) {
      var target = root.querySelector('[data-error-for="' + key + '"]');
      if (target) {
        target.textContent = errors[key];
        var field = root.querySelector('.rth-field[data-key="' + key + '"]');
        if (field) field.classList.add('has-error');
      }
    });
    var first = root.querySelector('.rth-field.has-error');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderTimes(container) {
    container.innerHTML = '';

    container.appendChild(el('div', { class: 'rth-week-nav' }, [
      el('button', {
        type: 'button', class: 'rth-btn rth-btn-ghost rth-btn-sm', text: '← Fyrri vika',
        disabled: state.weekOffset <= 0 ? 'disabled' : null,
        onclick: function () { if (state.weekOffset > 0) { state.weekOffset--; goToTimes(); } }
      }),
      el('button', {
        type: 'button', class: 'rth-btn rth-btn-ghost rth-btn-sm', text: 'Næsta vika →',
        onclick: function () { state.weekOffset++; goToTimes(); }
      })
    ]));

    var anySlots = false;
    var grid = el('div', { class: 'rth-days' });

    state.days.forEach(function (day) {
      var column = el('div', { class: 'rth-day' + (day.lokad ? ' is-closed' : '') });
      column.appendChild(el('div', { class: 'rth-day-head' }, [
        el('strong', { text: day.vikudagur }),
        el('span', { text: day.dagsetningTexti })
      ]));

      if (day.lokad || !day.timar.length) {
        column.appendChild(el('p', { class: 'rth-day-empty', text: day.astaeda || 'Enginn laus tími' }));
      } else {
        anySlots = true;
        var list = el('div', { class: 'rth-slots' });
        day.timar.forEach(function (slot) {
          list.appendChild(el('button', {
            type: 'button',
            class: 'rth-slot' + (state.slot && state.slot.byrjar === slot.byrjar ? ' is-selected' : ''),
            text: slot.timi,
            onclick: function () {
              state.slot = slot;
              state.date = day.dagsetning;
              state.step = 'tengilidur';
              render();
            }
          }));
        });
        column.appendChild(list);
      }
      grid.appendChild(column);
    });

    container.appendChild(grid);

    if (!anySlots) {
      container.appendChild(el('p', { class: 'rth-note', text: 'Enginn laus tími þessa viku. Prófaðu næstu viku.' }));
    }

    container.appendChild(el('div', { class: 'rth-actions' }, [
      el('button', {
        type: 'button', class: 'rth-btn rth-btn-ghost', text: '← Til baka',
        onclick: function () { state.step = 'spurningar'; render(); }
      })
    ]));
  }

  // -- step 3: contact details ---------------------------------------------

  function renderContact(container) {
    container.innerHTML = '';

    container.appendChild(el('div', { class: 'rth-chosen' }, [
      el('strong', { text: state.service.name }),
      el('span', { text: state.slot.langurTexti })
    ]));

    var fields = [
      { key: 'nafn', label: 'Nafn', type: 'text', required: true, autocomplete: 'name' },
      { key: 'simi', label: 'Símanúmer', type: 'tel', required: true, autocomplete: 'tel', placeholder: '555 1234' },
      { key: 'netfang', label: 'Netfang', type: 'email', required: false, autocomplete: 'email' }
    ];

    var inputs = {};
    fields.forEach(function (field) {
      var input = el('input', {
        class: 'rth-input',
        type: field.type,
        autocomplete: field.autocomplete,
        placeholder: field.placeholder || ''
      });
      inputs[field.key] = input;
      container.appendChild(el('div', { class: 'rth-field', 'data-key': field.key }, [
        el('label', { class: 'rth-label' }, [field.label, field.required ? el('span', { class: 'rth-required', text: ' *' }) : null]),
        input,
        el('p', { class: 'rth-field-error', 'data-error-for': field.key })
      ]));
    });

    var notes = el('textarea', { class: 'rth-input', rows: '3', placeholder: 'Valfrjálst' });
    container.appendChild(el('div', { class: 'rth-field' }, [
      el('label', { class: 'rth-label', text: 'Athugasemd' }),
      notes
    ]));

    var submitButton = el('button', { type: 'button', class: 'rth-btn rth-btn-primary', text: 'Staðfesta bókun' });
    submitButton.addEventListener('click', function () {
      if (state.submitting) return;
      state.submitting = true;
      submitButton.disabled = true;
      submitButton.textContent = 'Bóka…';
      showError('');

      request('/bokun', {
        slug: slug,
        serviceId: state.service.id,
        byrjar: state.slot.byrjar,
        starfsmadur: state.slot.starfsmadurId || null,
        svor: state.answers,
        nafn: inputs.nafn.value,
        simi: inputs.simi.value,
        netfang: inputs.netfang.value,
        athugasemd: notes.value
      })
        .then(function (data) {
          state.confirmation = data;
          state.step = 'stadfest';
          render();
        })
        .catch(function (error) {
          state.submitting = false;
          submitButton.disabled = false;
          submitButton.textContent = 'Staðfesta bókun';
          showError(error.message);
          // The slot may have been taken while the form was open.
          if (/laus/i.test(error.message)) {
            state.slot = null;
            state.step = 'timi';
            goToTimes();
          }
        });
    });

    container.appendChild(el('div', { class: 'rth-actions' }, [
      el('button', {
        type: 'button', class: 'rth-btn rth-btn-ghost', text: '← Velja annan tíma',
        onclick: function () { state.step = 'timi'; render(); }
      }),
      submitButton
    ]));
  }

  // -- step 4: confirmation -------------------------------------------------

  function renderConfirmation(container) {
    container.innerHTML = '';
    var data = state.confirmation || {};

    container.appendChild(el('div', { class: 'rth-done' }, [
      el('div', { class: 'rth-check', text: '✓' }),
      el('h3', { text: 'Tíminn þinn er bókaður' }),
      el('p', { text: data.timi || '' }),
      el('p', { class: 'rth-note', text: data.skilabod || 'Þú færð staðfestingu senda.' })
    ]));

    container.appendChild(el('div', { class: 'rth-actions' }, [
      el('button', {
        type: 'button', class: 'rth-btn rth-btn-ghost', text: 'Bóka annan tíma',
        onclick: function () {
          state.answers = {}; state.service = null; state.slot = null;
          state.extraMinutes = 0; state.submitting = false; state.step = 'spurningar';
          render();
        }
      })
    ]));
  }

  // -- shell ----------------------------------------------------------------

  var STEPS = [
    { key: 'spurningar', label: 'Um erindið' },
    { key: 'timi', label: 'Veldu tíma' },
    { key: 'tengilidur', label: 'Tengiliður' },
    { key: 'stadfest', label: 'Staðfest' }
  ];

  function render() {
    if (!state.config) return;

    root.innerHTML = '';

    var progress = el('ol', { class: 'rth-progress' }, STEPS.map(function (step, index) {
      var currentIndex = STEPS.map(function (s) { return s.key; }).indexOf(state.step);
      var cls = index < currentIndex ? 'is-done' : index === currentIndex ? 'is-current' : '';
      return el('li', { class: cls }, [el('span', { class: 'rth-progress-num', text: String(index + 1) }), step.label]);
    }));

    var body = el('div', { class: 'rth-body rth-step-' + state.step });
    var error = el('div', { class: 'rth-error', role: 'alert' });
    error.style.display = 'none';

    root.appendChild(progress);
    root.appendChild(error);
    root.appendChild(body);

    if (state.step === 'spurningar') {
      body.appendChild(el('p', { class: 'rth-intro', text: state.config.flow ? state.config.flow.intro : '' }));
      var questionHost = el('div', { class: 'rth-step-spurningar' });
      body.appendChild(questionHost);
      renderQuestions();
    } else if (state.step === 'timi') {
      renderTimes(body);
    } else if (state.step === 'tengilidur') {
      renderContact(body);
    } else {
      renderConfirmation(body);
    }
  }

  // -- boot -----------------------------------------------------------------

  root.innerHTML = '<p class="rth-loading">Sæki lausa tíma…</p>';

  request('/uppsetning?slug=' + encodeURIComponent(slug))
    .then(function (config) {
      state.config = config;
      if (config.services.length === 1) state.service = config.services[0];
      render();
    })
    .catch(function () {
      root.innerHTML = '<p class="rth-loading">Ekki tókst að sækja bókunarkerfið. Vinsamlegast hringdu í okkur.</p>';
    });
})();
`;
}

/** Styles for the widget, shared by every design variant. */
export function bookingWidgetStyles(): string {
  return `
#rth-bokun { --rth-radius: var(--corner, 14px); }
.rth-loading, .rth-note { color: var(--muted); font-size: .95rem; }
.rth-progress { display:flex; flex-wrap:wrap; gap:.5rem 1.25rem; list-style:none; padding:0; margin:0 0 1.5rem;
                font-size:.85rem; color:var(--muted); }
.rth-progress li { display:flex; align-items:center; gap:.5rem; }
.rth-progress-num { display:grid; place-items:center; width:1.55rem; height:1.55rem; border-radius:50%;
                    background:var(--surface-alt); border:1px solid var(--border); font-weight:700; font-size:.8rem; }
.rth-progress li.is-current { color:var(--ink); font-weight:600; }
.rth-progress li.is-current .rth-progress-num { background:var(--brand); color:var(--on-brand); border-color:var(--brand); }
.rth-progress li.is-done .rth-progress-num { background:var(--brand-light); border-color:var(--brand); color:var(--brand-dark); }

.rth-intro { color:var(--muted); margin:0 0 1.5rem; }
.rth-field { margin-bottom:1.5rem; }
.rth-label { display:block; font-weight:600; margin-bottom:.4rem; }
.rth-required { color:#dc2626; }
.rth-help { margin:0 0 .6rem; color:var(--muted); font-size:.88rem; }
.rth-input { width:100%; padding:.75rem .9rem; border:1px solid var(--border); border-radius:10px;
             font:inherit; color:inherit; background:var(--surface); box-sizing:border-box; }
.rth-input:focus { outline:2px solid var(--brand); outline-offset:1px; border-color:var(--brand); }
.rth-field.has-error .rth-input { border-color:#dc2626; }
.rth-field-error { color:#dc2626; font-size:.85rem; margin:.4rem 0 0; min-height:0; }

.rth-options { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:.6rem; }
.rth-option { display:flex; flex-direction:column; gap:.2rem; text-align:left; padding:.8rem .95rem;
              border:1px solid var(--border); border-radius:10px; background:var(--surface); cursor:pointer;
              font:inherit; color:inherit; transition:border-color .15s ease, background .15s ease; }
.rth-option:hover { border-color:var(--brand); }
.rth-option.is-selected { border-color:var(--brand); background:var(--brand-light); box-shadow:inset 0 0 0 1px var(--brand); }
.rth-option-label { font-weight:600; }
.rth-option-desc { font-size:.85rem; color:var(--muted); }

.rth-suggest { margin-top:.75rem; }
.rth-suggest-list { display:grid; gap:.5rem; margin-top:.6rem; }
.rth-suggestion { display:grid; gap:.15rem; text-align:left; padding:.7rem .9rem; border:1px dashed var(--border);
                  border-radius:10px; background:var(--surface-alt); cursor:pointer; font:inherit; color:inherit; }
.rth-suggestion:hover { border-color:var(--brand); border-style:solid; }
.rth-suggestion span { font-size:.88rem; color:var(--muted); }

.rth-summary { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; padding:.85rem 1rem;
               background:var(--surface-alt); border-radius:10px; font-size:.92rem; margin-bottom:1.25rem; }
.rth-dot { color:var(--muted); }

.rth-week-nav { display:flex; justify-content:space-between; gap:.75rem; margin-bottom:1rem; }
.rth-days { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:.75rem; }
.rth-day { border:1px solid var(--border); border-radius:12px; padding:.75rem; background:var(--surface); }
.rth-day.is-closed { opacity:.55; }
.rth-day-head { display:grid; gap:.1rem; margin-bottom:.6rem; text-align:center; }
.rth-day-head strong { text-transform:capitalize; font-size:.9rem; }
.rth-day-head span { font-size:.8rem; color:var(--muted); }
.rth-day-empty { font-size:.82rem; color:var(--muted); text-align:center; margin:.5rem 0; }
.rth-slots { display:grid; gap:.35rem; }
.rth-slot { padding:.5rem; border:1px solid var(--border); border-radius:8px; background:var(--surface);
            cursor:pointer; font:inherit; font-weight:600; font-size:.9rem; color:inherit; }
.rth-slot:hover, .rth-slot.is-selected { background:var(--brand); color:var(--on-brand); border-color:var(--brand); }

.rth-chosen { display:grid; gap:.2rem; padding:1rem; border-radius:10px; background:var(--brand-light);
              margin-bottom:1.5rem; }

.rth-actions { display:flex; flex-wrap:wrap; gap:.75rem; margin-top:1.5rem; }
.rth-btn { padding:.8rem 1.4rem; border-radius:10px; border:1px solid transparent; font:inherit; font-weight:600;
           cursor:pointer; }
.rth-btn-primary { background:var(--brand); color:var(--on-brand); }
.rth-btn-primary:hover { background:var(--brand-dark); }
.rth-btn-primary:disabled { opacity:.6; cursor:progress; }
.rth-btn-ghost { background:transparent; border-color:var(--border); color:inherit; }
.rth-btn-ghost:hover { border-color:var(--brand); color:var(--brand); }
.rth-btn-ghost:disabled { opacity:.4; cursor:default; }
.rth-btn-sm { padding:.5rem .9rem; font-size:.88rem; }

.rth-error { padding:.85rem 1rem; border-radius:10px; background:#fef2f2; color:#991b1b;
             border:1px solid #fecaca; margin-bottom:1.25rem; font-size:.92rem; }

.rth-done { text-align:center; padding:1.5rem 0; }
.rth-check { width:3rem; height:3rem; border-radius:50%; background:var(--brand); color:var(--on-brand);
             display:grid; place-items:center; font-size:1.5rem; margin:0 auto 1rem; }
`;
}
