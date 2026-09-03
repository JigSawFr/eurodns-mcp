import { describe, expect, it } from 'vitest';
import { stripMarkup } from '../src/tools/overrides.js';

/**
 * These descriptions end up in the tool descriptions a model reads. Nothing here is a
 * security boundary — the input is vendored and read at build time, the output is never
 * rendered as markup — so the bar is correctness, not sanitization.
 */
describe('stripping the markup out of a description', () => {
  it('removes the markup the document actually contains', () => {
    // `<br>` is the only tag in any of the document's 762 description fields.
    expect(stripMarkup('Takes an <code>id</code>.<br>Returns a TLD.')).toBe(
      'Takes an id. Returns a TLD.',
    );
    expect(stripMarkup('<br/>')).toBe('');
    expect(stripMarkup('  spaced   <b>out</b>  ')).toBe('spaced out');
  });

  /**
   * The defect that prompted the change. The previous pattern treated any span between two
   * angle brackets as a tag, so a comparison lost the text between them — "values < 500 and
   * count > 0" became "values 0". Requiring a letter after `<` is what fixes it.
   */
  it('leaves a comparison alone', () => {
    expect(stripMarkup('values < 500 and count > 0')).toBe('values < 500 and count > 0');
    expect(stripMarkup('a < b and c > d')).toBe('a < b and c > d');
    expect(stripMarkup('size <= 10 > x')).toBe('size <= 10 > x');
  });

  /**
   * Why the strip repeats. `[^<>]*` cannot cross a `<`, so the inner `<a>` matches first and
   * removing it joins the halves either side into a real `<script>`. Dropping the loop hands
   * that back intact and turns this red.
   */
  it('does not hand back a tag it assembled while removing another', () => {
    expect(stripMarkup('<scr<a>ipt>alert(1)</scr<a>ipt>')).toBe('alert(1)');
  });

  /**
   * Bare brackets are not tags and are left as written — visible rather than half-eaten.
   * Both cases also pin termination: neither can loop, because no pass changes the text.
   */
  it('leaves what is not tag-shaped exactly as written', () => {
    expect(stripMarkup('<<<<<<')).toBe('<<<<<<');
    expect(stripMarkup('<<b>>text<</b>>')).toBe('<>text<>');
  });
});
