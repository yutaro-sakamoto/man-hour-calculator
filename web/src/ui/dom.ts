/**
 * DOM を組み立てるための最小限のヘルパ。
 *
 * 画面は TypeScript から組み立てる。HTML テンプレートに `data-i18n` を
 * 散らす方式だと、言語切り替えのたびに属性を舐め直すことになり、
 * 動的に増える行との扱いも二重になるため。
 */

export type Child = Node | string | number | null | false | undefined;

interface Options {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  id?: string;
  attrs?: Record<string, string | number | boolean | null>;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void;
  }>;
}

/** 要素を作る。 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: Options = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.class !== undefined) element.className = options.class;
  if (options.id !== undefined) element.id = options.id;
  if (options.title !== undefined) element.title = options.title;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.html !== undefined) element.innerHTML = options.html;

  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    // ARIA の真偽は文字列の "true" / "false"。`disabled` のような本物の
    // 真偽属性と違い、**付いているだけでは true にならず**、`false` を
    // 省くと「値なし」として読み上げに伝わらない。
    if (typeof value === "boolean" && name.startsWith("aria-")) {
      element.setAttribute(name, String(value));
      continue;
    }
    if (value === null || value === false) continue;
    element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const [name, value] of Object.entries(options.dataset ?? {})) {
    element.dataset[name] = value;
  }
  Object.assign(element.style, options.style ?? {});
  for (const [name, handler] of Object.entries(options.on ?? {})) {
    element.addEventListener(name, handler as EventListener);
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function clear(element: Element): void {
  element.replaceChildren();
}

/** 見出しつきのカード。 */
export function card(title: string | null, children: Child[], extraClass = ""): HTMLElement {
  return h("section", { class: `card ${extraClass}`.trim() }, [
    title === null ? null : h("h2", { text: title }),
    ...children,
  ]);
}

/** ラベルつきの入力欄。 */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, [
    h("span", { class: "field-label", text: label }),
    control,
    hint === undefined ? null : h("span", { class: "field-hint", text: hint }),
  ]);
}

export function textInput(value: string, onInput: (value: string) => void, options: Options = {}) {
  return h("input", {
    ...options,
    attrs: { type: "text", value, ...options.attrs },
    on: {
      input: (event) => {
        onInput((event.target as HTMLInputElement).value);
      },
    },
  });
}

export function numberInput(
  value: number | string,
  onChange: (value: string) => void,
  options: Options = {},
) {
  return h("input", {
    ...options,
    class: `num ${options.class ?? ""}`.trim(),
    attrs: { type: "number", value: String(value), ...options.attrs },
    on: {
      input: (event) => {
        onChange((event.target as HTMLInputElement).value);
      },
    },
  });
}

export function dateInput(
  value: string | null,
  onChange: (value: string | null) => void,
  options: Options = {},
) {
  return h("input", {
    ...options,
    attrs: { type: "date", value: value ?? "", ...options.attrs },
    on: {
      change: (event) => {
        const next = (event.target as HTMLInputElement).value;
        onChange(next === "" ? null : next);
      },
    },
  });
}

export function checkbox(
  checked: boolean,
  onChange: (checked: boolean) => void,
  options: Options = {},
) {
  return h("input", {
    ...options,
    attrs: { type: "checkbox", ...options.attrs, checked },
    on: {
      change: (event) => {
        onChange((event.target as HTMLInputElement).checked);
      },
    },
  });
}

export function select<T extends string>(
  value: T,
  choices: readonly { value: T; label: string }[],
  onChange: (value: T) => void,
  options: Options = {},
): HTMLSelectElement {
  const element = h(
    "select",
    {
      ...options,
      on: {
        change: (event) => {
          onChange((event.target as HTMLSelectElement).value as T);
        },
      },
    },
    choices.map((choice) =>
      h("option", {
        text: choice.label,
        attrs: { value: choice.value, selected: choice.value === value },
      }),
    ),
  );
  element.value = value;
  return element;
}

export function button(
  label: string,
  onClick: () => void,
  options: Options = {},
): HTMLButtonElement {
  return h("button", {
    ...options,
    text: label,
    attrs: { type: "button", ...options.attrs },
    on: {
      click: () => {
        onClick();
      },
    },
  });
}

/** アイコンだけのボタン。読み上げ用に必ずラベルを付ける。 */
export function iconButton(
  glyph: string,
  label: string,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  return button(glyph, onClick, {
    class: "icon",
    title: label,
    attrs: { "aria-label": label, disabled },
  });
}

/** 表のヘッダ行を作る。 */
export function headerRow(cells: { label: string; class?: string }[]): HTMLTableRowElement {
  return h(
    "tr",
    {},
    cells.map((cell) => h("th", { text: cell.label, class: cell.class ?? "" })),
  );
}

/**
 * 畳めるカード。
 *
 * 開いているかどうかは**呼び出し側が覚える**。画面は変更のたびに作り直すので、
 * `<details>` に任せると、中の入力を触った瞬間に畳まれてしまう。
 */
export function foldout(
  options: {
    id: string;
    title: string;
    open: boolean;
    onToggle: (open: boolean) => void;
    /** 見出しの右に置く小さな印 (接続先のチップなど)。 */
    badge?: Child;
  },
  children: Child[],
): HTMLElement {
  return h(
    "details",
    {
      class: "card foldout",
      id: options.id,
      attrs: { open: options.open },
      on: {
        toggle: (event) => {
          const open = (event.target as HTMLDetailsElement).open;
          // 自分で書き戻した `open` の通知は捨てる。`<details open>` を組み立て
          // 直すたびにブラウザは `toggle` を投げるので、素直に受けると
          // 「開いた → 状態を変える → 描き直す → また開いた通知」で回り続ける。
          if (open === options.open) return;
          options.onToggle(open);
        },
      },
    },
    [
      h("summary", {}, [
        h("span", { class: "foldout-title", text: options.title }),
        options.badge ?? null,
      ]),
      ...children,
    ],
  );
}
