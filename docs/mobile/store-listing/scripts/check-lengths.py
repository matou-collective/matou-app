#!/usr/bin/env python3
"""Check LISTING.md text blocks against Play's limits (title 30, short 80, full 4000)."""
import re, sys
from pathlib import Path
md = (Path(__file__).resolve().parents[1] / "LISTING.md").read_text()
blocks = re.findall(r"## (Short description|Full description) \(\d+\)\n\n```\n(.*?)\n```", md, re.S)
limits = {"Short description": 80, "Full description": 4000}
ok = True
title = re.search(r"App name \(30\) \| `([^`]+)`", md).group(1)
print(f"App name: {len(title)}/30")
for name, text in blocks:
    n = len(text); lim = limits[name]; flag = "OK" if n <= lim else "OVER"
    ok &= n <= lim; print(f"{name}: {n}/{lim} {flag}")
sys.exit(0 if ok else 1)
