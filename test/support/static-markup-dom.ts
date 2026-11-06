/**
 * Just enough `document` for a module that looks up index.html's containers
 * as it loads (`renderer/lib/dom`), so a component that imports one can be
 * drawn with `renderToStaticMarkup` in node. Import it before the component.
 * Nothing is ever rendered into these elements.
 */
const element = (): unknown => ({
    style: {},
    classList: {add() {}, remove() {}, toggle() {}, contains: () => false},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    setAttribute() {},
    getAttribute: () => null,
    contains: () => false,
});

const scope = globalThis as {document?: unknown};
scope.document ??= {
    getElementById: element,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: element,
    addEventListener() {},
    removeEventListener() {},
    body: element(),
    documentElement: element(),
};

export {};
