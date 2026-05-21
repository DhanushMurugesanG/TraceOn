# TraceOn dev Makefile
# Manages SigNoz, spike backend, spike frontend, and TraceOn build commands.
# All commands are non-blocking unless noted.
#
# Note: the TraceOn MCP server is NOT started here — Claude Code launches it
# as a stdio subprocess. `make status` shows whether it's running.

SIGNOZ_DIR := /Users/dhanushmurugesan/Github-Personal/Signoz/signoz/deploy/docker
SPIKE_DIR := /Users/dhanushmurugesan/Github-Personal/traceon-spike
TRACEON_DIR := /Users/dhanushmurugesan/Github-Personal/TraceOn

.PHONY: help
help: ## Show this help
	@echo "TraceOn dev commands:"
	@echo ""
	@echo "  make up               Start everything (signoz + spike backend + spike frontend)"
	@echo "  make down             Stop everything"
	@echo "  make status           Show what's running"
	@echo ""
	@echo "  make signoz-up        Start SigNoz containers"
	@echo "  make signoz-down      Stop SigNoz containers"
	@echo "  make signoz-logs      Tail SigNoz logs"
	@echo "  make signoz-ui        Open SigNoz UI in browser"
	@echo ""
	@echo "  make spike-backend    Start the spike backend (foreground)"
	@echo "  make spike-frontend   Start the spike frontend (foreground)"
	@echo "  make spike-test       Run the spike Playwright test standalone"
	@echo ""
	@echo "  make build            Rebuild TraceOn packages"
	@echo "  make typecheck        Typecheck TraceOn packages"
	@echo ""
	@echo "  make claude-restart   Kill and tell you to restart Claude Code"
	@echo "  make logs-signoz-errors    Show SigNoz query errors (last 5)"

# ============================================================================
# Convenience: bring everything up / down
# ============================================================================

.PHONY: up
up: signoz-up
	@echo ""
	@echo "SigNoz starting. The spike backend and frontend need separate terminals."
	@echo ""
	@echo "In terminal 2: make spike-backend"
	@echo "In terminal 3: make spike-frontend"
	@echo ""
	@echo "Then 'make status' to check everything."

.PHONY: down
down: signoz-down
	@echo ""
	@echo "SigNoz stopped. If spike backend or frontend are running,"
	@echo "Ctrl+C in their terminals."

.PHONY: status
status:
	@echo "=== SigNoz containers ==="
	@docker ps --filter "name=signoz" --format "table {{.Names}}\t{{.Status}}" || echo "Docker not running"
	@echo ""
	@echo "=== Spike backend (port 3001) ==="
	@curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3001/api/summarize \
		-X POST -H "Content-Type: application/json" -d '{"text":"ping"}' 2>/dev/null \
		|| echo "Not responding"
	@echo ""
	@echo "=== Spike frontend (port 5173) ==="
	@curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:5173 2>/dev/null \
		|| echo "Not responding"
	@echo ""
	@echo "=== Claude Code MCP process ==="
	@ps aux | grep "packages/mcp/dist" | grep -v grep || echo "No MCP server running"

# ============================================================================
# SigNoz
# ============================================================================

.PHONY: signoz-up
signoz-up:
	@echo "Starting SigNoz..."
	@cd $(SIGNOZ_DIR) && docker compose up -d
	@echo ""
	@echo "SigNoz starting. UI will be at http://localhost:8080 in ~60s."

.PHONY: signoz-down
signoz-down:
	@echo "Stopping SigNoz..."
	@cd $(SIGNOZ_DIR) && docker compose down

.PHONY: signoz-logs
signoz-logs:
	@docker logs signoz --tail 50 -f

.PHONY: signoz-ui
signoz-ui:
	@open http://localhost:8080

.PHONY: logs-signoz-errors
logs-signoz-errors:
	@docker logs signoz --tail 100 2>&1 | grep -E "(query_range.*500|error)" | tail -5

# ============================================================================
# Spike — run these in separate terminals (each is foreground / blocks)
# ============================================================================

.PHONY: spike-backend
spike-backend:
	@echo "Starting spike backend (Ctrl+C to stop)..."
	@cd $(SPIKE_DIR) && pnpm dev:backend

.PHONY: spike-frontend
spike-frontend:
	@echo "Starting spike frontend (Ctrl+C to stop)..."
	@cd $(SPIKE_DIR) && pnpm dev:frontend

.PHONY: spike-test
spike-test:
	@echo "Running spike Playwright test standalone (without TraceOn)..."
	@cd $(SPIKE_DIR) && pnpm exec playwright test tests/spike.spec.ts

# ============================================================================
# TraceOn build commands
# ============================================================================

.PHONY: build
build:
	@cd $(TRACEON_DIR) && pnpm build

.PHONY: typecheck
typecheck:
	@cd $(TRACEON_DIR) && pnpm typecheck

# ============================================================================
# Claude Code
# ============================================================================

.PHONY: claude-restart
claude-restart:
	@echo "Killing Claude Code processes..."
	@pkill -f claude || echo "(nothing to kill)"
	@sleep 2
	@echo ""
	@echo "Claude Code killed. Now manually restart:"
	@echo "  cd $(TRACEON_DIR) && claude"
