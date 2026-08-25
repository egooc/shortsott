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
        # 있/없 license the dependent noun (or bare noun) before them: "-ㄹ 수(도) 있다",
        # "-ㄹ 리 없다", "방해 없이". kiwi tags 도 as JX (a good boundary in general), so this
        # binding needs its own check (shipped sample: "벌어질 수도 | 있었던").
        if (
            right_first in {"VA", "VV"} and right_tokens[0].form in {"있", "없"}
        ) or (
            # 없이 is tagged MAG as a whole word but still licenses the noun before it
            # ("방해 없이", "말썽 없이") - same binding, different tokenization.
            right_first == "MAG" and right_tokens[0].form == "없이"
        ):
            left_bare_noun = left_last in {"NNG", "NNP", "NNB", "XSN", "XR"}
            left_nnb_particle = (
                len(left_tokens) >= 2
                and left_tokens[-1].tag.startswith("J")
                and left_tokens[-2].tag == "NNB"
            )
            if left_bare_noun or left_nnb_particle:
                verdicts.append((False, -100))
                continue
        if left_last in _FORBID_AFTER:
            verdicts.append((False, -100))
            continue
        if left_last == "JKO":
            # Object binds to its verb; splitting is tolerable only when the object PHRASE is
            # long enough to stand alone. Measure the noun phrase, not the single word: a
            # determiner/genitive/pronoun in front ("내 말을", "우리 집을") makes a short object
            # word a fine chunk ending (shipped sample: "내 말을 그렇게 | 쉽게 믿다니" chose a
            # worse break because 말을 alone was forbidden).
            np_len = len(words[index - 1])
            walk = index - 2
            while walk >= 0 and grouped[walk]:
                prev_last = grouped[walk][-1].tag
                if prev_last in {"MM", "JKG", "NP"} and len(words[walk]) <= 2:
                    np_len += len(words[walk])
                    walk -= 1
                    continue
                break
            if np_len <= 2:
                verdicts.append((False, -100))
                continue
            verdicts.append((True, 10))
            continue
        if left_last in _GOOD_AFTER:
            # -게 adverbial forms (그렇게/쉽게/빠르게) modify the predicate AFTER them even
            # though kiwi tags the ending EC like clause connectives (-고/-서/-면). Keep the
            # boundary legal but weak so a real clause/phrase close wins when one exists.
            if left_last == "EC" and left_tokens[-1].form == "게":
                verdicts.append((True, 15))
                continue
            verdicts.append((True, 80))
            continue
        # Bare noun before another word usually modifies it (compound) - weak boundary.
        verdicts.append((True, 20))
    return verdicts
