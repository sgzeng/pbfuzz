# Vendored third-party code

`yaml/` is the pure-Python part of [PyYAML](https://pyyaml.org/) 6.0.3 (`lib/yaml` of the sdist
`pyyaml-6.0.3.tar.gz`, sha256 `d76623373421df22fb4cf8817020cbb7ef15c725b9d5e45f17e189bfc384190f`),
unmodified, under the MIT license in `PYYAML-LICENSE`. The libyaml C extension is not included;
PyYAML falls back to its pure-Python loader and dumper without it.

It exists so the npm package `@pbfuzz/dsh-pbfuzz` runs on any Python >= 3.11 without a `pip install`:
`packages/dsh-pbfuzz/scripts/stage-engine.mjs` copies it next to `pbfuzz_engine/` in the package,
and the plugin puts that directory on the sidecar's `PYTHONPATH`. In a source checkout it is
unused; the engine venv installs PyYAML from PyPI as before.

To update: replace `yaml/` and `PYYAML-LICENSE` from a newer sdist and update the version and
sha256 above.
