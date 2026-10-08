"""Spot Run runtime.

Runs one Python function with generated inputs, replaces effectful
dependencies with lazy fakes, blocks real side effects, and records a
line-level trace that the VS Code extension replays in the editor.

Standard library only. Supports Python 3.8+.
"""

__version__ = "0.1.0"
