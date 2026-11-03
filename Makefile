.PHONY: test test-py test-web e2e build up down

test: test-py test-web

test-py:
	.venv/bin/python -m pytest -q

test-web:
	cd web && npm test -- --run

e2e: up
	cd web && npx playwright test

build:
	docker compose build

up:
	docker compose up -d --build

down:
	docker compose down
