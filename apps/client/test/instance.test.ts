import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fillInstance, instanceFrom, missingOperator, UNSET } from '../src/instance.ts';

const PAGES = [
  'index.html',
  'timelapse.html',
  'contributors.html',
  'terms.html',
  'privacy.html',
  'trademarks.html',
];

describe('instance settings (ADR 0037)', () => {
  it('reads nothing the build does not set', () => {
    expect(instanceFrom({})).toEqual({
      operatorName: null,
      operatorAddress: null,
      contactEmail: null,
      sourceUrl: null,
      kofiUrl: null,
      sponsorInfoUrl: null,
    });
  });

  it('keeps https links and plain addresses only', () => {
    const instance = instanceFrom({
      VITE_OPERATOR_NAME: '  Example Co  ',
      VITE_CONTACT_EMAIL: 'javascript:alert(1)@x.example',
      VITE_SOURCE_URL: 'https://git.example/game/',
      VITE_KOFI_URL: 'javascript:alert(1)',
    });
    expect(instance.operatorName).toBe('Example Co');
    expect(instance.contactEmail).toBeNull();
    expect(instance.sourceUrl).toBe('https://git.example/game');
    expect(instance.kofiUrl).toBeNull();
    expect(instanceFrom({ VITE_SOURCE_URL: 'https://git.example/r?a=1#x' }).sourceUrl).toBe(
      'https://git.example/r',
    );
  });

  it('names the operator settings a deploy build still lacks', () => {
    expect(missingOperator(instanceFrom({}))).toEqual([
      'VITE_OPERATOR_NAME',
      'VITE_OPERATOR_ADDRESS',
      'VITE_CONTACT_EMAIL',
    ]);
    const blank = instanceFrom({
      VITE_OPERATOR_NAME: '   ',
      VITE_OPERATOR_ADDRESS: '1 Main St',
      VITE_CONTACT_EMAIL: 'Ops <a@b.example>',
    });
    expect(missingOperator(blank)).toEqual(['VITE_OPERATOR_NAME', 'VITE_CONTACT_EMAIL']);
    const set = instanceFrom({
      VITE_OPERATOR_NAME: 'Example Co',
      VITE_OPERATOR_ADDRESS: '1 Main St',
      VITE_CONTACT_EMAIL: 'a@b.example',
    });
    expect(missingOperator(set)).toEqual([]);
  });

  it("escapes % so Vite's own placeholder pass leaves values alone", () => {
    const filled = fillInstance(
      '{{operatorName}}',
      instanceFrom({ VITE_OPERATOR_NAME: 'Ops %VITE_KOFI_URL%' }),
    );
    expect(filled).toBe('Ops &#37;VITE_KOFI_URL&#37;');
  });

  it('links the contributing guide in the source repository, or nowhere', () => {
    const page = '{{contributingUrl}}';
    expect(fillInstance(page, instanceFrom({}))).toBe('#');
    expect(fillInstance(page, instanceFrom({ VITE_SOURCE_URL: 'https://git.example/r' }))).toBe(
      'https://git.example/r/blob/HEAD/CONTRIBUTING.md',
    );
  });

  it('fills the pages with escaped values, and says when one is unset', () => {
    const page =
      '<p>{{operatorName}}, {{operatorAddress}} <a href="{{contactHref}}">{{contactEmail}}</a></p>';
    const filled = fillInstance(
      page,
      instanceFrom({ VITE_OPERATOR_NAME: 'A <b>&</b> "B"', VITE_CONTACT_EMAIL: 'hi@e.example' }),
    );
    expect(filled).toBe(
      `<p>A &lt;b&gt;&amp;&lt;/b&gt; &quot;B&quot;, ${UNSET} <a href="mailto:hi@e.example">hi@e.example</a></p>`,
    );
    expect(() => fillInstance('{{operatorNmae}}', instanceFrom({}))).toThrow(/operatorNmae/);
  });

  it('leaves no placeholder in any page and names no operator in the source', () => {
    for (const name of PAGES) {
      const html = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
      const filled = fillInstance(html, instanceFrom({}));
      expect(filled, name).not.toMatch(/\{\{|\}\}/);
      expect(html, name).not.toMatch(/ko-fi\.com\/|mailto:[^{]|github\.com\//);
    }
  });
});
