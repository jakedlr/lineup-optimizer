.PHONY: test test-py test-web e2e build up down

test: test-py test-web

test-py:
	.venv/bin/python -m pytest -q

test-web:
	cd web && npm test -- --run

E2E = PPOPT_PORT=8001 docker compose -p ppopt-e2e -f docker-compose.yml -f docker-compose.e2e.yml

e2e:
	$(E2E) down -v
	$(E2E) up -d --build --wait
	cd web && PPOPT_URL=http://localhost:8001 npx playwright test; status=$$?; cd .. && $(E2E) down -v; exit $$status

build:
	docker compose build

up:
	docker compose up -d --build

down:
	docker compose down
