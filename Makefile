# Dance Fantasy: one-command dev workflow. Run `make help` for targets.
SHELL := /bin/bash

.PHONY: help setup setup-server setup-web dev server web test test-server test-web build songs

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*## ' Makefile | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

setup: setup-server setup-web ## Install everything (first run)

setup-server: ## Python 3.11 venv + deps (uv)
	cd server && uv sync

setup-web: ## npm deps + MediaPipe wasm/models into web/public/mediapipe
	cd web && npm install && npm run setup:mediapipe

dev: ## Start API (:8000) and web (:5173) together; Ctrl-C stops both
	./scripts/dev.sh

server: ## Start only the API server (auto-reload)
	cd server && uv run uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port 8000

web: ## Start only the web dev server
	cd web && npm run dev

test: test-server test-web ## Run all tests

test-server: ## pytest (beat tracking, API, shared contract)
	cd server && uv run pytest -q

test-web: ## typecheck + vitest (pose normalization, skeleton contract)
	cd web && npm run typecheck && npm test

build: ## Production build of the web app (web/dist)
	cd web && npm run build

songs: ## Regenerate the synthetic test songs in assets/songs
	cd server && uv run python scripts/make_sample_song.py --all
