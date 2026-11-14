/** BRO-3538: guard the actual E2E selectors and their component markup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
const read = file => ts.createSourceFile(file, readFileSync(new URL(file, root), 'utf8'), ts.ScriptTarget.Latest, true);
const specs = ['my-shows-mock', 'user-flows', 'ugc-interactive-qa'].map(name => read(`tests/e2e/${name}.spec.ts`));

function collect(source, predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return matches;
}

for (const spec of specs) {
  test(`${spec.fileName} selects elements independently of CSS classes`, () => {
    const calls = collect(spec, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['locator', 'querySelector', 'querySelectorAll', 'waitForSelector'].includes(node.expression.name.text));
    const brittle = calls.filter(call => {
      const selector = call.arguments[0];
      if (!selector || !(ts.isStringLiteral(selector) || ts.isNoSubstitutionTemplateLiteral(selector))) return false;
      // Ignore dots in attribute values, such as input[accept=".json"].
      return /\[\s*class\b/.test(selector.text) || /\.[a-zA-Z_-]/.test(selector.text.replace(/\[[^\]]*\]/g, ''));
    });
    assert.deepEqual(brittle.map(call => `${spec.getLineAndCharacterOfPosition(call.getStart()).line + 1}: ${call.getText()}`), [],
      'Use getByTestId or an accessible role instead of styling-dependent selectors');
  });
}

const contracts = [
  ['src/app/my-shows/MyShowsClient.tsx', 'MyShowsClient', 'my-shows-controls', 'div', 1],
  ['src/app/my-shows/MyShowsClient.tsx', 'MyShowsClient', 'my-shows-grid', 'div', 7],
  ['src/app/my-shows/MyShowsClient.tsx', 'ToBeRatedSection', 'my-shows-grid', 'div', 1],
  ['src/app/my-shows/MyShowsClient.tsx', 'DiaryCard', 'diary-card', 'div', 1],
  ['src/app/my-shows/MyShowsClient.tsx', 'DiaryCard', 'diary-venue', 'p', 1],
  ['src/app/my-shows/MyShowsClient.tsx', 'DiaryCard', 'diary-desktop-rating', 'span', 1],
  ['src/app/my-shows/MyShowsClient.tsx', 'DiaryGridCard', 'diary-rating', 'div', 1],
  ['src/components/user/upcoming-cards.tsx', 'PosterGridCard', 'poster-grid-card', 'div', 1],
  ['src/components/user/upcoming-cards.tsx', 'PosterGridCard', 'poster-grid-image', 'div', 1],
  ['src/components/show-cards/Modal.tsx', 'Modal', 'modal-backdrop', 'div', 1],
];

for (const [file, component, id, tag, count] of contracts) {
  test(`${component} renders ${id} on its ${tag} and E2E uses getByTestId`, () => {
    const source = read(file);
    const producer = collect(source, node => ts.isFunctionDeclaration(node) && node.name?.text === component)[0];
    assert.ok(producer, `${component} must exist in ${file}`);
    const elements = collect(producer, node => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText() === 'data-testid'
        && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === id));
    assert.equal(elements.length, count, `${id} must stay on the actual ${component} elements`);
    for (const element of elements) {
      assert.equal(element.tagName.getText(), tag);
      if (id === 'diary-rating') {
        const rating = element.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText() === 'data-rating');
        assert.equal(rating?.initializer?.getText(), '{review.rating}', 'ordering test must read the rendered review rating');
      }
    }
    assert.ok(specs.some(spec => collect(spec, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'getByTestId' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === id).length > 0), `${id} must be used by an audited E2E spec`);
  });
}
