# Host proxy for code-browser in Docker: see docs/host-proxy.md.
PYTHON ?= python3
ARGS ?=

# Directory of this Makefile (with trailing slash), so `make -C <checkout> proxy` works from anywhere.
ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.DEFAULT_GOAL := help
.PHONY: help proxy

help:
	@echo "Targets:"
	@echo "  proxy   run the host proxy (proxy/proxy.py) in the foreground"
	@echo "  help    show this list"
	@echo ""
	@echo "Variables:"
	@echo "  PYTHON  interpreter to run proxy.py with, e.g. PYTHON=python3.11"
	@echo "  ARGS    extra arguments passed verbatim to proxy.py, e.g. ARGS=\"--ports 9222,9223\""

proxy:
	$(PYTHON) "$(ROOT)proxy/proxy.py" $(ARGS)
