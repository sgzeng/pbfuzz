"""`signature.py`: what `generate` can be called with, read from source without running it."""

from __future__ import annotations

from pbfuzz_engine.signature import fit_kwargs, read_signature, signature_issues


def _sig(write_generator, source: str):
    return read_signature(write_generator(source))


def test_explicit_keywords_reject_what_they_do_not_name(write_generator):
    sig = _sig(write_generator, "def generate(a=1, b=2):\n    return b''\n")
    assert sig is not None and not sig.var_keyword
    assert sig.accepts("a") and not sig.accepts("seed")
    assert signature_issues(sig, {"a", "c"}) == [
        "`generate` cannot take c, which the plan supplies; add it as keyword parameter(s) or accept `**kwargs`",
    ]


def test_var_keyword_accepts_anything(write_generator):
    sig = _sig(write_generator, "def generate(**params):\n    return b''\n")
    assert sig is not None and sig.accepts("seed") and sig.accepts("anything")
    assert signature_issues(sig, {"x", "y"}) == []


def test_a_required_parameter_the_plan_never_supplies_is_named(write_generator):
    sig = _sig(write_generator, "def generate(width, *, height, depth=1):\n    return b''\n")
    assert signature_issues(sig, {"width"}) == [
        "`generate` requires height, which the plan never supplies; give it a default or add it to parameter_space",
    ]


def test_positional_only_without_default_cannot_be_called_by_keyword(write_generator):
    sig = _sig(write_generator, "def generate(a, /, b=0):\n    return b''\n")
    assert any("positional-only" in issue for issue in signature_issues(sig, {"b"}))


def test_unknowable_signatures_are_never_rejected_on_a_guess(write_generator):
    assert _sig(write_generator, "generate = lambda **p: b''\n") is None
    assert _sig(write_generator, "from somewhere import generate\n") is None
    assert signature_issues(None, {"anything"}) == []
    assert fit_kwargs({"seed": 1, "x": 2}, None) == {"seed": 1, "x": 2}


def test_the_last_definition_wins_as_it_does_at_import(write_generator):
    sig = _sig(write_generator, "def generate(a):\n    return b''\n\ndef generate(**p):\n    return b''\n")
    assert sig is not None and sig.var_keyword


def test_fit_kwargs_drops_only_what_cannot_bind(write_generator):
    sig = _sig(write_generator, "def generate(a=1, b=2):\n    return b''\n")
    assert fit_kwargs({"a": 1, "b": 2, "seed": 3}, sig) == {"a": 1, "b": 2}
