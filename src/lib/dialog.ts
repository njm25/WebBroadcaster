// Standard in-app dialogs that replace the browser's alert(), confirm() and
// prompt(). Shared by the studio and the phone source page.
//
//   await alertDialog('Recording saved.');
//   if (await confirmDialog('Delete scene "Intro"?', { danger: true, okLabel: 'Delete' })) …
//   const name = await promptDialog('Scene name', { value: 'Scene 2' });   // null = cancelled
//
// Keyboard: Enter confirms, Esc cancels, Tab stays inside the dialog, and focus
// returns to where it was afterwards. Styles live in styles/global.css (.dlg-*).

export interface DialogButton<T> {
  label: string;
  value: T;
  /** 'primary' is the default action (Enter); 'danger' for destructive ones. */
  variant?: 'primary' | 'danger' | 'default';
}

export interface DialogOptions<T> {
  title?: string;
  message?: string | Node;
  buttons: DialogButton<T>[];
  /** Value returned for Esc / clicking outside. */
  cancelValue: T;
  /** Optional text field; its value is passed to `onSubmit`. */
  input?: {
    value?: string;
    placeholder?: string;
    type?: 'text' | 'number';
    min?: number;
    max?: number;
    /** Return an error message to block submitting, or null when valid. */
    validate?: (value: string) => string | null;
  };
  /** Accessible role: 'alertdialog' for alerts/confirms that need a response. */
  role?: 'dialog' | 'alertdialog';
}

let idSeq = 0;

/** General-purpose dialog. Resolves with the chosen button's value (and the input text). */
export function openDialog<T>(opts: DialogOptions<T>): Promise<{ value: T; text: string }> {
  return new Promise((resolve) => {
    const id = `dlg-${++idSeq}`;
    const previousFocus = document.activeElement as HTMLElement | null;

    const backdrop = document.createElement('div');
    backdrop.className = 'dlg-backdrop';
    const box = document.createElement('div');
    box.className = 'dlg';
    box.setAttribute('role', opts.role ?? 'dialog');
    box.setAttribute('aria-modal', 'true');
    backdrop.append(box);

    if (opts.title) {
      const h = document.createElement('h2');
      h.className = 'dlg-title';
      h.id = `${id}-title`;
      h.textContent = opts.title;
      box.append(h);
      box.setAttribute('aria-labelledby', h.id);
    }
    if (opts.message !== undefined) {
      const p = document.createElement('div');
      p.className = 'dlg-message';
      p.id = `${id}-msg`;
      if (typeof opts.message === 'string') p.textContent = opts.message;
      else p.append(opts.message);
      box.append(p);
      box.setAttribute('aria-describedby', p.id);
    }

    let input: HTMLInputElement | null = null;
    let error: HTMLDivElement | null = null;
    if (opts.input) {
      input = document.createElement('input');
      input.className = 'dlg-input';
      input.type = opts.input.type ?? 'text';
      input.value = opts.input.value ?? '';
      if (opts.input.placeholder) input.placeholder = opts.input.placeholder;
      if (opts.input.min !== undefined) input.min = String(opts.input.min);
      if (opts.input.max !== undefined) input.max = String(opts.input.max);
      input.setAttribute('aria-label', opts.title ?? 'Value');
      error = document.createElement('div');
      error.className = 'dlg-error';
      error.setAttribute('role', 'alert');
      box.append(input, error);
    }

    const actions = document.createElement('div');
    actions.className = 'dlg-actions';
    box.append(actions);

    let done = false;
    const finish = (value: T) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 120);
      previousFocus?.focus?.();
      resolve({ value, text: input?.value ?? '' });
    };
    const submit = (value: T) => {
      if (input && opts.input?.validate && value !== opts.cancelValue) {
        const msg = opts.input.validate(input.value);
        if (msg) {
          error!.textContent = msg;
          input.focus();
          return;
        }
      }
      finish(value);
    };

    const btnEls: HTMLButtonElement[] = [];
    let primary: DialogButton<T> | undefined;
    for (const b of opts.buttons) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `dlg-btn ${b.variant ?? 'default'}`;
      el.textContent = b.label;
      el.addEventListener('click', () => submit(b.value));
      actions.append(el);
      btnEls.push(el);
      if (b.variant === 'primary' || b.variant === 'danger') primary ??= b;
    }
    primary ??= opts.buttons[opts.buttons.length - 1];

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(opts.cancelValue);
      } else if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (primary) submit(primary.value);
      } else if (e.key === 'Tab') {
        // Keep focus inside the dialog.
        const focusables = [...(input ? [input] : []), ...btnEls];
        const i = focusables.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        const next = (i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
        focusables[next].focus();
      } else {
        // Don't let studio shortcuts fire behind the dialog.
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) finish(opts.cancelValue);
    });
    input?.addEventListener('input', () => {
      if (error) error.textContent = '';
    });

    document.body.append(backdrop);
    if (input) {
      input.focus();
      input.select();
    } else {
      const p = btnEls[opts.buttons.indexOf(primary!)];
      (p ?? btnEls[0])?.focus();
    }
  });
}

/** Replacement for alert(). */
export async function alertDialog(message: string, opts: { title?: string; okLabel?: string } = {}): Promise<void> {
  await openDialog({
    title: opts.title,
    message,
    role: 'alertdialog',
    buttons: [{ label: opts.okLabel ?? 'OK', value: true, variant: 'primary' }],
    cancelValue: true,
  });
}

/** Replacement for confirm(). Resolves true when confirmed. */
export async function confirmDialog(
  message: string,
  opts: { title?: string; okLabel?: string; cancelLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  const { value } = await openDialog({
    title: opts.title,
    message,
    role: 'alertdialog',
    buttons: [
      { label: opts.cancelLabel ?? 'Cancel', value: false },
      { label: opts.okLabel ?? 'OK', value: true, variant: opts.danger ? 'danger' : 'primary' },
    ],
    cancelValue: false,
  });
  return value;
}

/** Replacement for prompt(). Resolves the entered text, or null when cancelled. */
export async function promptDialog(
  title: string,
  opts: {
    message?: string;
    value?: string;
    placeholder?: string;
    okLabel?: string;
    type?: 'text' | 'number';
    min?: number;
    max?: number;
    validate?: (value: string) => string | null;
  } = {},
): Promise<string | null> {
  const { value, text } = await openDialog({
    title,
    message: opts.message,
    input: {
      value: opts.value,
      placeholder: opts.placeholder,
      type: opts.type,
      min: opts.min,
      max: opts.max,
      validate: opts.validate ?? ((v) => (v.trim() ? null : 'Please enter a value.')),
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: opts.okLabel ?? 'OK', value: true, variant: 'primary' },
    ],
    cancelValue: false,
  });
  return value ? text.trim() : null;
}
