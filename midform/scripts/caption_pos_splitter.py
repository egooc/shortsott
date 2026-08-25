# -*- coding: utf-8 -*-
"""POS-driven caption boundary analysis.

The enumerated forbidden-boundary rules in assemble_slot_draft_input.py were a growing list of
grammar facts rediscovered one owner complaint at a time ("해." stranded, 뭘 blocked as a
modifier, 못 split from its verb). Korean syntax does not enumerate; a morphological analyzer
answers the same questions from first principles:

  - a particle binds to the word BEFORE it (조사),
  - adverbs, determiners and adnominal forms bind to the word AFTER them (부사/관형사/관형형),
  - an auxiliary verb binds to its main verb (보조용언),
  - clause connectives (-고/-서/-는지/-면) END a phrase, which is exactly where a caption
    may break.

kiwipiepy is local, deterministic and dependency-free. When it is unavailable the caller keeps
its enumerated rules as the fallback.
"""

_kiwi = None
_kiwi_failed = False


def _get_kiwi():
    global _kiwi, _kiwi_failed
    if _kiwi is not None or _kiwi_failed:
        return _kiwi
    try:
        from kiwipiepy import Kiwi
        _kiwi = Kiwi()
    except Exception:
        _kiwi_failed = True
        _kiwi = None
    return _kiwi


def pos_available():
    return _get_kiwi() is not None


# Word-final tags: what the LAST meaningful morpheme of a word says about the boundary after it.
_GOOD_AFTER = {
    "JKS", "JX",          # subject/topic particle - the subject phrase just closed
    "JKB",                # adverbial particle (에/에서/로) - an adjunct closed
    "EC",                 # clause connective (-고/-서/-는지/-면) - a clause closed
    "EF", "SF",           # sentence endings
    "JC",                 # conjunctive particle (와/과 at phrase end)
}
_FORBID_AFTER = {
    "MM",                 # determiner (이/그/저/새/옛)
    "MAG", "MAJ",         # adverbs (못/안/더/왜...) bind forward
    "ETM",                # adnominal form (-는/-ㄴ/-ㄹ) binds to the following noun
    "JKG",                # genitive 의
}
# Word-initial tags of the RIGHT word that forbid a break before it.
_FORBID_BEFORE = {
    "VX",                 # auxiliary verb (오게 | 하다, -지 | 않다)
    "XSV", "XSA",         # verbalizing suffixes leaking to word start after tokenization quirks
}


def _word_tags(sentence):
    """Group kiwi tokens into the sentence's space-separated words by character span."""
    kiwi = _get_kiwi()
    if kiwi is None:
        return None
    words = sentence.split()
    spans = []
    cursor = 0
    for word in words:
        start = sentence.index(word, cursor)
        spans.append((start, start + len(word)))
        cursor = start + len(word)
    grouped = [[] for _ in words]
    for token in kiwi.tokenize(sentence):
        for index, (start, end) in enumerate(spans):
            if token.start >= start and token.start < end:
                grouped[index].append(token)
                break
    return grouped


def analyze_boundaries(words):
    """For a list of words, classify each of the len(words)-1 boundaries.

    Returns a list of (allowed, score) or None when the analyzer is unavailable.
    Higher score = better break point.
    """
    sentence = " ".join(words)
    grouped = _word_tags(sentence)
    if grouped is None or len(grouped) != len(words):
        return None
    verdicts = []
    for index in range(1, len(words)):
        left_tokens = grouped[index - 1]
        right_tokens = grouped[index]
        if not left_tokens or not right_tokens:
            verdicts.append((True, 20))
            continue
        left_last = left_tokens[-1].tag
        right_first = right_tokens[0].tag
        # Sentence punctuation attached to the left word looks past it.
        if left_last in {"SF", "SP", "SE", "SS"} and len(left_tokens) >= 2:
            left_last = left_tokens[-2].tag
        if right_first in _FORBID_BEFORE:
            verdicts.append((False, -100))
            continue
        if left_last in _FORBID_AFTER:
            verdicts.append((False, -100))
            continue
        if left_last == "JKO":
            # Object binds to its verb; splitting is tolerable only when the object phrase is
            # long enough to stand alone, which the width search decides - mark weak, not
            # forbidden, unless the object word is short.
            if len(words[index - 1]) <= 2:
                verdicts.append((False, -100))
                continue
            verdicts.append((True, 10))
            continue
        if left_last in _GOOD_AFTER:
            verdicts.append((True, 80))
            continue
        # Bare noun before another word usually modifies it (compound) - weak boundary.
        verdicts.append((True, 20))
    return verdicts
