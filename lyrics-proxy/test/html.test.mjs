import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    cleanLyrics,
    decodeEntities,
    extractGeniusLyrics,
    removeExcludedNodes,
    sliceElement,
    stripTags,
} from '../src/lib/html.js';

describe('decodeEntities', () => {
    it('handles named, decimal and hex entities', () => {
        assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), 'a & b <c> "d" \'e\'');
        assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
        assert.equal(decodeEntities('&nbsp;x'), ' x');
    });

    it('leaves unknown entities and plain text alone', () => {
        assert.equal(decodeEntities('&unknown; plain'), '&unknown; plain');
        assert.equal(decodeEntities('no entities'), 'no entities');
    });

    it('ignores out of range code points', () => {
        assert.equal(decodeEntities('&#999999999;'), '');
    });
});

describe('stripTags', () => {
    it('turns br into newlines and drops markup', () => {
        assert.equal(stripTags('a<br>b<br/>c<br />d'), 'a\nb\nc\nd');
        assert.equal(stripTags('<b>bold</b> <i>italic</i>'), 'bold italic');
    });

    it('removes scripts, styles and comments', () => {
        assert.equal(stripTags('x<script>evil()</script>y<style>.a{}</style>z<!-- c -->'), 'xyz');
    });
});

describe('cleanLyrics', () => {
    it('normalizes whitespace and blank lines', () => {
        assert.equal(cleanLyrics('  a  \r\n\r\n\r\n\r\nb  \n'), 'a\n\nb');
    });

    it('returns null for empty input', () => {
        assert.equal(cleanLyrics('   \n\n '), null);
        assert.equal(cleanLyrics(''), null);
        assert.equal(cleanLyrics(undefined), null);
    });
});

describe('sliceElement', () => {
    it('walks nested elements of the same tag', () => {
        const html = '<div class="a">one<div>two</div>three</div><div>next</div>';
        const inner = sliceElement(html, /<div[^>]*class="a"[^>]*>/i);
        assert.equal(inner, 'one<div>two</div>three');
    });

    it('returns null when the tag is missing', () => {
        assert.equal(sliceElement('<p>x</p>', /<div>/i), null);
    });

    it('tolerates an unterminated element', () => {
        assert.equal(sliceElement('<div>dangling', /<div>/i), 'dangling');
    });
});

describe('removeExcludedNodes', () => {
    it('removes the node and its children', () => {
        const html = 'keep<span data-exclude-from-selection="true">drop <b>me</b></span>keep2';
        assert.equal(removeExcludedNodes(html), 'keepkeep2');
    });

    it('removes several nodes', () => {
        const html = 'a<div data-exclude-from-selection="true">x</div>b<div data-exclude-from-selection="true">y</div>c';
        assert.equal(removeExcludedNodes(html), 'abc');
    });

    it('leaves markup without the attribute untouched', () => {
        assert.equal(removeExcludedNodes('a<span>b</span>c'), 'a<span>b</span>c');
    });
});

describe('extractGeniusLyrics', () => {
    it('joins multiple lyric containers', () => {
        const html = [
            '<div data-lyrics-container="true">[Verse 1]<br/>Line one<br/>Line two</div>',
            '<div data-lyrics-container="true">[Chorus]<br/>Line three</div>',
        ].join('');

        assert.equal(extractGeniusLyrics(html), '[Verse 1]\nLine one\nLine two\n[Chorus]\nLine three');
    });

    it('drops nodes marked as excluded', () => {
        const html =
            '<div data-lyrics-container="true">Line one<br/>' +
            '<span data-exclude-from-selection="true">You might also like</span>Line two</div>';

        assert.equal(extractGeniusLyrics(html), 'Line one\nLine two');
    });

    it('prefers the legacy lyrics div when present', () => {
        const html = '<div class="lyrics">legacy<br/>block</div><div data-lyrics-container="true">new</div>';
        assert.equal(extractGeniusLyrics(html), 'legacy\nblock');
    });

    it('decodes entities and strips inline markup', () => {
        const html = '<div data-lyrics-container="true"><b>Bold</b> &amp; <i>italic</i></div>';
        assert.equal(extractGeniusLyrics(html), 'Bold & italic');
    });

    it('returns null when there is no lyric markup', () => {
        assert.equal(extractGeniusLyrics('<html><body>nothing here</body></html>'), null);
        assert.equal(extractGeniusLyrics(''), null);
        assert.equal(extractGeniusLyrics(null), null);
    });
});
