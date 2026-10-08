"""Entry point started by the Spot Run extension."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from spotrun_runtime.runner import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
