# Shortcuts for the code-browser CDP proxy (see docs/proxy.md).
# Works from any directory: make -C <checkout> proxy

PYTHON ?= python3
ARGS ?=

ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.DEFAULT_GOAL := help
.PHONY: help proxy

help:
	@echo "Targets:"
	@echo "  proxy   run the CDP proxy in the foreground (Ctrl-C to stop)"
	@echo "  help    show this list (default)"
	@echo
	@echo "Variables:"
	@echo "  PYTHON  Python interpreter for the proxy (default: python3)"
	@echo "  ARGS    arguments passed verbatim to cdp_proxy.py, e.g. make proxy ARGS='--ports 9222,9223'"

proxy:
	$(PYTHON) $(ROOT)proxy/cdp_proxy.py $(ARGS)
