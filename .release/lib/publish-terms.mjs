/*
  The publish gate's term check: the personal-term list, and the case-insensitive search for it over file contents, file paths, ref names, a commit message, and `git log -p` text.
  In the app: nothing at runtime; the publish script's gate (step 2, and step 5 over the target's whole history) calls it.
  Used by: scripts/lib/publish-run.mjs; tested by scripts/lib/publish-gate.test.mjs.
  Uses: node builtins only.
  Exports: fold (text as matched), parseTerms (the list, folded), TermsError, scanBytes (a file in every encoding), scanPath, scanLabelled (a message or ref name), scanLog (`git log -p` text), describeHit (a hit as one report line).

  The list is HARNESS_DENYLIST: comma- or newline-separated, blank entries ignored (the same list, and the same
  comma format, as the leak test in scripts/doc-commands.test.mjs). A missing, blank, or all-blank list is
  an error here, never an empty pass: a gate that finds nothing because it was told to look for nothing is
  the leak this file exists to prevent. Only the caller decides that a local preview may skip the check.

  This is a tripwire for plain text, not a defence against deliberate encoding. It catches a term typed
  as itself, in any case, with accents, zero-width or format characters, odd spacing, full-width letters,
  curly quotes, typographic dashes or a German sharp s slipped in, and in a file saved as UTF-8, Latin-1/cp1252,
  UTF-16 or UTF-32. It does not catch a term that was encoded (base64, HTML entities, %-escapes, \u escapes),
  spelled with look-alike letters from another script, or split across lines or markup: someone set on
  getting a term past it can, and the real defence is that the owner reads what a preview lists. The owner
  must still review what the gate cannot detect.

  Matching folds both sides the same way (`fold`): Unicode compatibility decomposition (NFKD, so
  full-width letters and ligatures match and accents split off), every combining mark and format or
  invisible character dropped, any run of whitespace made one space (so a tab or two spaces inside a
  multi-word term still match), lower case, the Turkish dotted and dotless i read as i, the sharp s and
  long s spelled as ss and s, the curly single quotes (U+2018, U+2019, U+201B, U+2032) read as ', the curly
  double quotes (U+201C, U+201D) as ", and the hyphen-like dashes (U+2010 to U+2015, U+2212) as -. Letters with a stroke
  or bar, with a hook, descender or curl, and the ligatures, which NFKD leaves whole, are spelled plain from a table of the
  Latin ones (STROKE_TABLE: the l, o, d, h, t, z, b, g, i, c, e, j, r, y, p, u, k, s with a stroke or bar, the b, d, f, g, h
  and other hook letters, eth d, ae, oe, thorn th), and the l with a middle dot (which NFKD splits into l and a dot) is l, so a
  name with and without its mark match either way. A Latin letter outside the table is not folded. Whitespace is Unicode's White_Space, not JavaScript's \s (which also counts the byte order mark U+FEFF
  and would turn it into a space, splitting a one-word term), and every Default_Ignorable_Code_Point is dropped, assigned or not.

  A term with a space in it is also matched with every space taken out of both the term and the text. That
  catches an invisible character standing in for the space: the fold drops a zero-width space or a Hangul
  filler, so "Jane<U+200B>Roe" folds to "janeroe", not "jane roe". The price is extra false positives, for
  multi-word terms only: "jane roe" also matches "janeroe" and "jan e roe", and a text that ends one word and
  starts the next with the term's letters in order. A one-word term never gets this, since it would then match
  across any two words.

  Every file is read as UTF-8, Latin-1/cp1252, UTF-16 (both byte orders, both alignments) and UTF-32 (both
  orders, all four alignments), NUL byte or not: a Latin-1 "Jos\xe9" or a UTF-16 Cyrillic name has none.
  A report names the term by its position in the list ("term #3"), never by its text, so a log or job summary never
  repeats what the list keeps secret.
*/

import { isAscii } from "node:buffer";

// Code point ranges that print as nothing but are not marks or format characters (Hangul fillers, the blank Braille cell).
// Numbers, not a regex of the characters: the characters are invisible in the source.
const BLANK_RANGES = [
  [0x115f, 0x1160],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xffa0, 0xffa0],
];

// One character class: every mark (\p{M}: accents, variation selectors, the grapheme joiner), every format character
// (\p{Cf}: zero-width and bidi marks, soft hyphen, tag characters, invisible musical symbols), every control, every
// Default_Ignorable_Code_Point (which also holds the code points Unicode reserves to be invisible but has not assigned: U+2065,
// U+FFF0 to U+FFF8, U+E0080 and on, none of them \p{Cf} yet), and the blanks.
const IGNORABLE = new RegExp(`[\\p{M}\\p{Cf}\\p{Cc}\\p{Default_Ignorable_Code_Point}${BLANK_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join("")}]`, "gu");

// Dotless i (U+0131) has no decomposition, so it is mapped by hand; the dotted capital (U+0130) decomposes to I plus a mark.
const DOTLESS_I = String.fromCodePoint(0x131);

// Typographic variants of the plain characters a term is typed with: curly single quotes and the prime, curly double quotes, hyphen-like dashes.
const CURLY_SINGLE = /[‘’‛′]/gu;
const CURLY_DOUBLE = /[“”]/gu;
const DASHES = /[‐-―−]/gu;

// Whitespace for the fold: Unicode's White_Space property, not JavaScript's \s. \s also counts the byte order mark U+FEFF, which would
// become a space before the format characters are dropped, and split a one-word term in two.
const WHITESPACE = /\p{White_Space}+/gu;

// Letters NFKD leaves whole, spelled as the plain letters they stand in for (after lower case): letters with a stroke or bar
// through them, letters with a hook, descender or curl, and the ligatures. As code points: [plain letters, ...code points].
// Unicode has no property saying "this is the letter a with an extra mark", so this is a table; it covers the Latin letters of
// that kind in Latin Extended-B, IPA Extensions, Latin Extended-C and -D, and phonetic extensions that a name is likely to use.
const STROKE_TABLE = [
  ["a", 0x2c65],
  ["b", 0x180, 0x253],
  ["c", 0x23c, 0x188],
  ["d", 0x111, 0xf0, 0x257, 0x256, 0x221],
  ["e", 0x247],
  ["f", 0x192],
  ["g", 0x1e5, 0x260],
  ["h", 0x127, 0x266, 0x2c68],
  ["i", 0x268],
  ["j", 0x249, 0x237],
  ["k", 0xa741, 0x199, 0x2c6a],
  ["l", 0x142, 0x2c61, 0x234],
  ["m", 0x271],
  ["n", 0x272, 0x273, 0x19e, 0x235],
  ["o", 0xf8],
  ["p", 0x1d7d, 0x1a5],
  ["q", 0x24b],
  ["r", 0x24d],
  ["s", 0xa7a9],
  ["t", 0x167, 0x2c66, 0x1ad, 0x236],
  ["u", 0x289, 0x1d7e],
  ["v", 0x28b],
  ["y", 0x24f, 0x1b4],
  ["z", 0x1b6, 0x2c6c],
  ["ae", 0xe6],
  ["oe", 0x153],
  ["th", 0xfe],
];
const STROKE_LETTERS = new Map(STROKE_TABLE.flatMap(([plain, ...points]) => points.map((point) => [String.fromCodePoint(point), plain])));
const STROKE_PATTERN = new RegExp(`[${[...STROKE_LETTERS.keys()].join("")}]`, "gu");

// Plain text needing none of the work below: printable ASCII, tabs and line breaks. Most files are this, so they cost a lowercase.
const PLAIN = /^[\t\n\r -~]*$/u;

// Text folded for matching (see the header).
export const fold = (text) => {
  if (PLAIN.test(text)) return text.replaceAll(/\s+/gu, " ").toLowerCase();
  return (
    text
      .normalize("NFKD")
      // Whitespace first, so a tab or newline becomes a space before the control characters are dropped.
      .replaceAll(WHITESPACE, " ")
      .replaceAll(IGNORABLE, "")
      .replaceAll(WHITESPACE, " ")
      .replaceAll(CURLY_SINGLE, "'")
      .replaceAll(CURLY_DOUBLE, '"')
      .replaceAll(DASHES, "-")
      .toLowerCase()
      .replaceAll(DOTLESS_I, "i")
      // The sharp s (and the long s, which NFKD already makes s) spelled out; after toLowerCase, so the capital sharp s is caught too.
      .replaceAll("ß", "ss")
      .replaceAll("ſ", "s")
      .replaceAll(STROKE_PATTERN, (letter) => STROKE_LETTERS.get(letter) ?? letter)
      // The l with a middle dot (U+0140) is l plus a middle dot under NFKD; the dot is part of the letter, not left behind.
      .replaceAll("l\u00b7", "l")
  );
};

// A thrown error the CLI prints as a red gate step instead of a stack trace.
export class TermsError extends Error {}

// The terms in a HARNESS_DENYLIST value, folded, in list order. Throws when the list has none.
export const parseTerms = (raw) => {
  if (typeof raw !== "string") throw new TermsError("HARNESS_DENYLIST is not set");
  const terms = raw
    .split(/[,\r\n]+/u)
    .map((entry) => fold(entry).trim())
    .filter((entry) => entry !== "");
  if (terms.length === 0) throw new TermsError("HARNESS_DENYLIST has no terms (empty or blank); an empty list would pass everything");
  return terms;
};

// Which of `terms` (folded) a folded `text` contains, as indexes into the list. A term with a space in it also matches with the
// spaces left out of both (see the header: an invisible character standing in for the space).
const matching = (folded, terms) => {
  let squashed;
  return terms.flatMap((term, index) => {
    if (folded.includes(term)) return [index];
    if (!term.includes(" ")) return [];
    squashed ??= folded.replaceAll(" ", "");
    return squashed.includes(term.replaceAll(" ", "")) ? [index] : [];
  });
};

// Hits in one text: { line, term } for each line (1-based) holding a term; the whole text is searched first, so a clean file costs one pass.
const hitsInText = (text, terms) => {
  const folded = fold(text);
  if (matching(folded, terms).length === 0) return [];
  const hits = [];
  text.split(/\r\n|\n|\r/u).forEach((line, at) => {
    for (const term of matching(fold(line), terms)) hits.push({ line: at + 1, term });
  });
  // A hit the whole-text pass saw but no single line holds (a term with a line break in it): report the file, line 0.
  if (hits.length === 0) for (const term of matching(folded, terms)) hits.push({ line: 0, term });
  return hits;
};

// UTF-16 big-endian text of `bytes` (Node decodes only little-endian): the even-length prefix with each byte pair swapped.
const utf16be = (bytes) => Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2))).swap16().toString("utf16le");

// UTF-32 text of `bytes` from `offset`, in the given byte order. Node has no UTF-32 decoder; a value that is not a
// character (past U+10FFFF, or a surrogate) reads as a space.
const utf32 = (bytes, offset, littleEndian) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const characters = [];
  for (let at = offset; at + 4 <= bytes.length; at += 4) {
    const code = view.getUint32(at, littleEndian);
    characters.push(code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? " " : String.fromCodePoint(code));
  }
  return characters.join("");
};

// cp1252 differs from Latin-1 only at 0x80 to 0x9f (smart quotes, the euro sign, where Latin-1 has control characters).
const CP1252 = new TextDecoder("windows-1252");
const HIGH_CONTROLS = /[\u0080-\u009f]/u;

// Every reading of a file's bytes as text, one at a time (a big file is not held as a dozen copies): UTF-8; Latin-1 and cp1252
// when the bytes are not all ASCII (else they read the same as UTF-8); UTF-16 and UTF-32 in both byte orders and every alignment.
// All of them for every file, NUL byte or not: a Latin-1 "Jos\xe9" or a UTF-16 Cyrillic name holds none.
function* readings(bytes) {
  yield bytes.toString("utf8");
  if (!isAscii(bytes)) {
    const latin1 = bytes.toString("latin1");
    yield latin1;
    if (HIGH_CONTROLS.test(latin1)) yield CP1252.decode(bytes);
  }
  yield bytes.toString("utf16le");
  yield bytes.subarray(1).toString("utf16le");
  yield utf16be(bytes);
  yield utf16be(bytes.subarray(1));
  for (const offset of [0, 1, 2, 3]) {
    yield utf32(bytes, offset, true);
    yield utf32(bytes, offset, false);
  }
}

// Hits in one file's bytes, read every way `readings` lists; the same line and term found in two readings is one hit.
export const scanBytes = (path, bytes, terms) => {
  const seen = new Set();
  const hits = [];
  for (const text of readings(bytes)) {
    for (const hit of hitsInText(text, terms)) {
      const key = `${hit.line}:${hit.term}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ where: "content", path, ...hit });
      }
    }
  }
  return hits;
};

// Hits in a path (the whole string, each segment included).
export const scanPath = (path, terms) => matching(fold(path), terms).map((term) => ({ where: "path", path, line: 0, term }));

// Hits in a free-text item (a commit message, a ref name), labelled `where`.
export const scanLabelled = (where, name, text, terms) => hitsInText(text, terms).map((hit) => ({ where, path: name, ...hit }));

// Hits in `git log -p --all` text. Tracks the commit and file each line belongs to, so a hit names them.
export const scanLog = (log, terms) => {
  const hits = [];
  let commit = "";
  let file = "(message)";
  log.split("\n").forEach((line, at) => {
    const header = /^commit ([0-9a-f]{40,64})$/u.exec(line);
    if (header !== null) {
      commit = header[1].slice(0, 12);
      file = "(message)";
      return;
    }
    const diffFile = /^\+\+\+ (?:b\/)?(.*)$/u.exec(line) ?? /^--- (?:a\/)?(.*)$/u.exec(line);
    if (diffFile !== null && diffFile[1] !== "/dev/null") file = diffFile[1];
    for (const term of matching(fold(line), terms)) hits.push({ where: "history", path: `${commit} ${file}`, line: at + 1, term });
  });
  return hits;
};

// One line per hit for a gate report: where it was found and which list entry, never the term itself.
export const describeHit = (hit) => `${hit.where} ${hit.path}${hit.line > 0 ? `:${hit.line}` : ""} matches term #${hit.term + 1}`;
